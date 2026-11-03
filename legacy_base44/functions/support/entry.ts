// "Get help": agents ask from anywhere in the app; the request arrives with a snapshot of their
// setup and open issues, raises a signal for the owner, and replies go back by email.
import { context, failure } from '../../shared/ghl.ts';
import { raise, resolve } from '../../shared/signals.ts';
import { readiness } from '../../shared/readiness.ts';
import { billingAccount } from '../../shared/stripeRest.ts';
import { emailAgent } from '../../shared/agentNotify.ts';
import { APP_ORIGIN } from '../../shared/appointmentJourney.ts';

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));
    const now = new Date().toISOString();

    if (input.action === 'create') {
      const message = String(input.message || '').trim();
      if (message.length < 3 || message.length > 4000) throw new Error('Tell us what you need help with (up to 4,000 characters).');
      const recent = await E.SupportRequest.count({ agent_email: user.email, created_at: { $gte: new Date(Date.now() - 3600000).toISOString() } });
      if (recent >= 5) throw new Error('You’ve sent several requests in the last hour. We’ll get back to you soon.');
      const s = (await E.AgentSettings.filter({ agent_email: user.email }, { limit: 1 })).items[0];
      // Snapshot what we'd otherwise have to ask: setup progress, open issues, account basics.
      const ctx: Record<string, any> = { page: String(input.page || '').slice(0, 200) };
      if (s) {
        const r = await readiness(E, s).catch(() => null);
        const w = await billingAccount(E, s.agent_email).catch(() => null);
        const issues = (await E.SystemEvent.filter({ agent_email: s.agent_email, status: 'open' }, { limit: 10, fields: ['title', 'kind'] })).items;
        Object.assign(ctx, {
          status: s.status, mode: s.mode, a2p: s.a2p_status, number: s.phone_number || '', brand: s.brand_name || '',
          setup: r ? `${r.items.filter((i: any) => i.done).length}/${r.items.length}` : '', next_step: r?.items.find((i: any) => !i.done)?.label || '',
          balance: w ? `$${((Number(w.balance_cents) || 0) / 100).toFixed(2)}` : '', subscription: w?.subscription_status || '',
          open_issues: issues.map((i: any) => i.title),
          leads: await E.Lead.count({ agent_email: s.agent_email }).catch(() => 0),
        });
      }
      const name = s ? [s.first_name, s.last_name].filter(Boolean).join(' ') || s.brand_name : user.full_name || user.email;
      const reqRow = await E.SupportRequest.create({ agent_email: user.email, agent_name: name || '', message, page: ctx.page, context: ctx, status: 'open', replies: [], created_at: now });
      await raise(base44, { key: `help:${reqRow.id}`, kind: 'help_request', agent_email: user.email, severity: 'warning', title: `Help request from ${name || user.email}`, detail: message.slice(0, 400), data: { request_id: reqRow.id }, notifyOwner: true });
      return Response.json({ ok: true, id: reqRow.id });
    }

    if (input.action === 'mine') {
      const rows = await E.SupportRequest.filter({ agent_email: user.email }, { sort: '-created_at', limit: 20 });
      return Response.json({ items: rows.items.map((r: any) => ({ id: r.id, message: r.message, status: r.status, replies: r.replies || [], created_at: r.created_at })) });
    }

    // Admin side.
    if (user.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { status: 403 });
    if (input.action === 'admin_list') {
      const rows = await E.SupportRequest.filter(input.status ? { status: input.status } : {}, { sort: '-created_at', limit: 50 });
      return Response.json({ items: rows.items });
    }
    const row = await E.SupportRequest.get(String(input.id || ''));
    if (input.action === 'reply') {
      const body = String(input.body || '').trim();
      if (!body) throw new Error('Write a reply first.');
      const s = (await E.AgentSettings.filter({ agent_email: row.agent_email }, { limit: 1 })).items[0];
      const sent = s ? await emailAgent(base44, s, 'Re: your LeadRespark help request', `${body}\n\n---\nYou asked: "${String(row.message).slice(0, 500)}"\n\nReply anytime with the Get help button: ${APP_ORIGIN}/dashboard`) : 'no agent';
      await E.SupportRequest.update(row.id, { status: 'answered', answered_at: now, replies: [...(row.replies || []), { from: user.email, body, at: now }] });
      await resolve(base44, `help:${row.id}`);
      return Response.json({ ok: true, sent });
    }
    if (input.action === 'close') { await E.SupportRequest.update(row.id, { status: 'closed' }); await resolve(base44, `help:${row.id}`); return Response.json({ ok: true }); }
    throw new Error('Unknown action.');
  } catch (e) { return failure(e as Error); }
}
