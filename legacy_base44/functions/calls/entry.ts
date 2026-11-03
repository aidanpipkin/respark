// Click-to-call: rings the agent's cell, then connects the lead from the same business number
// that texts them. Also call status, hang up, call history and voicemail playback.
import { setupContext, configFor } from '../../shared/setupAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { tw, subCred, API } from '../../shared/twilio.ts';
import { routeFor, e164 } from '../../shared/smsTransport.ts';
import { numberForLead, prettyPhone } from '../../shared/numbers.ts';
import { startCall, hangUp, leadLocalHour, callPriceCents } from '../../shared/voice.ts';
import { agentPhone } from '../../shared/agentNotify.ts';
import { exempt, subscriptionOkFor, maybeRecharge } from '../../shared/credits.ts';
import { billingAccount } from '../../shared/stripeRest.ts';

export default async function (req: Request) {
  try {
    const { E, s, user } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const own = (r: any) => { if (!r || r.agent_email !== s.agent_email) throw new Error('Not found.'); return r; };

    if (input.action === 'prepare' || input.action === 'start') {
      const lead = own(await E.Lead.get(String(input.lead_id || '')));
      const route = await routeFor(E, s);
      if (route.kind !== 'twilio') throw new Error('Calling works with a LeadRespark texting number. Set one up under Phone numbers.');
      const to = e164(lead.phone);
      if (!to) throw new Error("This lead doesn't have a valid phone number.");
      const from = await numberForLead(E, s, lead, route.from);
      const cell = e164(input.agent_phone) || agentPhone(s);
      const hour = leadLocalHour(lead, s);
      const blocked = lead.status === 'opted_out' ? 'This person opted out. Only call them if they asked you to, from your own phone.'
        : (hour < 8 || hour >= 21) ? `It's ${hour > 12 ? hour - 12 : hour || 12}${hour >= 12 ? 'pm' : 'am'} where ${lead.first_name || 'they'} live${lead.first_name ? 's' : ''}. Calls are allowed 8am to 9pm their time.` : '';
      const facts = (lead.lead_facts && typeof lead.lead_facts === 'object') ? lead.lead_facts : {};
      const localTime = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZone: lead.timezone || s.home_timezone || 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date()); } catch { return ''; } })();
      const lastCall = (await E.CallLog.filter({ agent_email: s.agent_email, lead_id: lead.id, status: { $in: ['completed', 'voicemail', 'no_answer', 'busy', 'missed'] } }, { sort: '-started_at', limit: 1, fields: ['status', 'started_at', 'duration_sec'] })).items[0] || null;
      const info = { from, from_pretty: prettyPhone(from), lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || prettyPhone(to), lead_phone: prettyPhone(to), cell, cell_pretty: prettyPhone(cell), blocked, local_hour: hour,
        lead: { id: lead.id, first_name: lead.first_name || '', status: lead.status, state: lead.state || '', local_time: localTime, interest: facts.product_interest || lead.product_interest || '', summary: String(lead.ai_summary || '').slice(0, 240), last_inbound_at: lead.last_inbound_at || '', last_call: lastCall } };
      if (input.action === 'prepare') return Response.json(info);

      if (blocked) throw new Error(blocked);
      if (!cell) throw new Error('Add your cell number so we can ring you first.');
      if (cell === to) throw new Error("That's the lead's number. Enter your own cell.");
      const config = await configFor(E);
      const billing = await billingAccount(E, s.agent_email);
      if (!subscriptionOkFor(config, billing, s.agent_email)) throw new Error('Your subscription needs to be active to place calls.');
      if (!exempt(config, s.agent_email)) {
        const need = callPriceCents(config) * 2;
        if ((Number(billing?.balance_cents) || 0) < need) await maybeRecharge(E, s.agent_email, need).catch(() => false);
        const b2 = await billingAccount(E, s.agent_email);
        if ((Number(b2?.balance_cents) || 0) < need) throw new Error('Add credits to place calls.');
      }
      // One call at a time per agent.
      const active = (await E.CallLog.filter({ agent_email: s.agent_email, direction: 'outbound', status: { $in: ['calling_agent', 'briefing', 'ringing_lead', 'in_progress'] }, started_at: { $gte: new Date(Date.now() - 2 * 3600000).toISOString() } }, { limit: 1 })).items[0];
      if (active) throw new Error('You already have a call going. Hang it up first.');
      const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
      if (!acct?.webhook_url) throw new Error('Calling is still being set up for your account.');
      const call = await startCall(E, s, lead, from, cell, acct.webhook_url, route.sub);
      if (input.remember_cell && e164(input.agent_phone) && !s.notification_phone) await E.AgentSettings.update(s.id, { notification_phone: cell }).catch(() => {});
      await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', lead_id: lead.id, actor_email: user.email, action: 'call_started', details: { from }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ call });
    }

    if (input.action === 'status') return Response.json({ call: own(await E.CallLog.get(String(input.id || ''))) });

    if (input.action === 'hangup') {
      const call = own(await E.CallLog.get(String(input.id || '')));
      const route = await routeFor(E, s);
      if (route.kind === 'twilio') await hangUp(call, route.sub);
      if (['calling_agent', 'briefing', 'ringing_lead'].includes(call.status)) await E.CallLog.update(call.id, { status: 'no_answer', ended_at: new Date().toISOString() });
      return Response.json({ ok: true });
    }

    if (input.action === 'list') {
      const q: any = { agent_email: s.agent_email };
      if (input.lead_id) q.lead_id = String(input.lead_id);
      const rows = await E.CallLog.filter(q, { sort: '-started_at', limit: Math.min(100, Number(input.limit) || 30) });
      return Response.json({ items: rows.items });
    }

    if (input.action === 'recording') {
      const call = own(await E.CallLog.get(String(input.id || '')));
      if (!call.recording_sid) throw new Error('No recording on this call.');
      const route = await routeFor(E, s);
      if (route.kind !== 'twilio') throw new Error('Recording unavailable.');
      const cred = await subCred(route.sub);
      const res = await fetch(`${API}/Accounts/${cred.sid}/Recordings/${call.recording_sid}.mp3`, { headers: { Authorization: `Basic ${btoa(`${cred.sid}:${cred.token}`)}` }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('Recording is not ready yet. Try again in a minute.');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 4_000_000) throw new Error('Recording is too long to play here.');
      let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return Response.json({ data_url: `data:audio/mpeg;base64,${btoa(bin)}` });
    }
    throw new Error('Unknown action.');
  } catch (e) { return failure(e as Error); }
}
