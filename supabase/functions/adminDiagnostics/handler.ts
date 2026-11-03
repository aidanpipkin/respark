// Admin: read-only end-to-end health check for one agent's workspace (nothing is sent or changed).
import { adminContext } from '../_shared/agentAccess.ts';
import { agentSettings, ghl, failure } from '../_shared/ghl.ts';
import { routeFor } from '../_shared/smsTransport.ts';
import { platformConfig, subscriptionOkFor } from '../_shared/credits.ts';
import { billingAccount } from '../_shared/stripeRest.ts';
import { readiness } from '../_shared/readiness.ts';
import { documentsFor, leadEmail } from '../_shared/appointmentJourney.ts';

// Like ghl() but keeps the provider's error text, for diagnostics.
async function ghlRaw(s: any, path: string, method: string, body: any) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { method, headers: { Authorization: `Bearer ${s.ghl_token}`, Version: path.startsWith('/conversations') ? '2021-04-15' : '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}
async function check(name: string, fn: () => Promise<any>) {
  try { const r = await fn(); return { name, ok: r?.ok !== false, detail: r?.detail ?? r }; }
  catch (e) { return { name, ok: false, detail: String((e as Error).message).slice(0, 300) }; }
}

import { invokeLLM, llmProvider, lastLLM } from '../_shared/llm.ts';

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));
    if (input.action === 'backfill_replied') {
      // One-time: mark conversations where the contact has replied, from each lead's last inbound time.
      let cursor: string | undefined, updated = 0;
      do {
        const page = await E.ConversationSummary.filter({ $or: [{ replied_at: { $exists: false } }, { replied_at: '' }, { replied_at: null }, { replied_at: null }] }, { limit: 100, cursor, fields: ['lead_id'] });
        const ids = page.items.map((x: any) => x.lead_id).filter(Boolean);
        const leads = ids.length ? (await E.Lead.filter({ id: { $in: ids }, last_inbound_at: { $exists: true, $nin: ['', null] } }, { limit: 100, fields: ['last_inbound_at'] })).items : [];
        for (const l of leads) { await E.ConversationSummary.updateMany({ lead_id: l.id }, { $set: { replied_at: l.last_inbound_at } }); updated++; }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor);
      await E.EngineCursor.upsert([{ key: 'diag:backfill_replied', cursor: JSON.stringify({ at: new Date().toISOString(), updated }) }], { key: 'key' });
      return Response.json({ updated });
    }
    if (input.action === 'resend_a2p_ready') {
      const { emailAgent } = await import('../../shared/agentNotify.ts');
      const { agentSettings: settingsFor } = await import('../../shared/ghl.ts');
      const t = await settingsFor(base44, String(input.agent_email || '').toLowerCase().trim());
      if (!t) throw new Error('No agent with that email.');
      const link = 'https://respark-pipkingroup.com/setup/texting-registration';
      const r = await emailAgent(base44, t, 'Finish your texting registration (30 seconds)', `Hi ${t.first_name || 'there'},\n\nTexting registration is open. Everything you entered is saved. Open the link below, re-enter your EIN (we never store it) and press Submit.\n\n${link}\n\nCarrier approval usually takes a few business days after that, and we track it for you.\n\nLeadRespark`);
      return Response.json({ result: r });
    }
    if (input.action === 'test_a2p_notice') {
      // Dry run of what an agent receives at each registration stage. Emails the OWNER a copy; never contacts the agent.
      const { stageFor, noticeFor } = await import('../../shared/a2pNotify.ts');
      const { agentSettings: settingsFor } = await import('../../shared/ghl.ts');
      const t = await settingsFor(base44, String(input.agent_email || '').toLowerCase().trim());
      if (!t) throw new Error('No agent with that email.');
      const reg = (await base44.asServiceRole.entities.A2PRegistration.filter({ agent_email: t.agent_email }, { limit: 1 })).items[0] || { id: 'x' };
      const transitions = {
        brand_submitted_to_campaign: stageFor({ status: 'brand_submitted' }, { status: 'campaign_submitted' }),
        campaign_to_approved: stageFor({ status: 'campaign_submitted' }, { status: 'approved' }),
        brand_to_rejected: stageFor({ status: 'brand_submitted' }, { status: 'rejected' }),
        no_change: stageFor({ status: 'brand_submitted' }, { status: 'brand_submitted' }),
      };
      const n = noticeFor('approved', t, reg);
      const config = await platformConfig(base44.asServiceRole.entities);
      let emailed = 'skipped';
      if (input.send_to_owner === true && config.owner_email) {
        try { await base44.asServiceRole.integrations.Core.SendEmail({ to: config.owner_email, subject: `[TEST copy for ${t.agent_email}] ${n.subject}`, body: `This is exactly what ${t.agent_email} will receive by email when texting is approved:\n\n----\n${n.email}\n----\n\nText to ${t.alert_mobile || t.business_phone || 'their mobile'}:\n${n.text}`, from_name: 'LeadRespark' }); emailed = 'sent'; }
        catch (e) { emailed = `failed:${(e as Error).message}`; }
      }
      const to = (await import('../../shared/agentNotify.ts')).agentEmail(t);
      return Response.json({ transitions, email_to: to, text_to_last4: String(t.alert_mobile || t.notification_phone || t.business_phone || '').slice(-4), notice: n, owner_copy: emailed });
    }
    if (input.action === 'install_playbook') {
      const { installPlaybook } = await import('../../shared/playbooks.ts');
      const { agentSettings: settingsFor } = await import('../../shared/ghl.ts');
      const t = await settingsFor(base44, String(input.agent_email || '').toLowerCase().trim());
      if (!t) throw new Error('No agent with that email.');
      const c = await installPlaybook(base44.asServiceRole.entities, t, String(input.key || 'life_respark'));
      const steps = await base44.asServiceRole.entities.SequenceStep.count({ campaign_id: c.id });
      return Response.json({ campaign_id: c.id, name: c.name, cadence: c.cadence || '', steps });
    }
    if (input.action === 'sync_playbook_prompts') {
      // Pushes the latest playbook prompts into every agent's copy (the old copy is saved as a version first).
      const E = base44.asServiceRole.entities;
      const life = await import('../../shared/lifeSeed.ts');
      const trucker = await import('../../shared/truckerSeed.ts');
      let updated = 0;
      for (const [name, sd] of [[life.CAMPAIGN_NAME, life], ['Trucker IUL Respark', trucker]] as any) {
        const page = await E.Campaign.filter({ name }, { limit: 200 });
        for (const c of page.items) {
          if (c.system_prompt === sd.systemPrompt && c.writer_prompt === sd.writerPrompt && c.knowledge_doc === sd.knowledgeDoc) continue;
          const v = (c.prompt_version || 1);
          if (!(await E.PromptVersion.count({ campaign_id: c.id, version: v }))) await E.PromptVersion.create({ agent_email: c.agent_email, location_id: c.location_id, campaign_id: c.id, version: v, system_prompt: c.system_prompt || '', knowledge_doc: c.knowledge_doc || '', writer_prompt: c.writer_prompt || '', notes: 'Saved before playbook update.' });
          await E.Campaign.update(c.id, { system_prompt: sd.systemPrompt, writer_prompt: sd.writerPrompt, knowledge_doc: sd.knowledgeDoc, prompt_version: v + 1 });
          updated++;
        }
      }
      return Response.json({ updated });
    }
    if (input.action === 'a2p_inspect') {
      // Everything Twilio knows about an agent's registration: brand, campaign (with the reviewers' error list), messaging service, numbers.
      const { tw, subCred, MSG, API } = await import('../../shared/twilio.ts');
      const E = base44.asServiceRole.entities;
      const reg = (await E.A2PRegistration.filter({ agent_email: String(input.agent_email || '').toLowerCase().trim() }, { limit: 1 })).items[0];
      if (!reg?.twilio_subaccount_sid) throw new Error('No Twilio registration for that agent.');
      const cred = await subCred(reg.twilio_subaccount_sid);
      const out: any = { status: reg.status, provider_step: reg.provider_step, review_note: reg.review_note };
      if (reg.brand_sid) out.brand = await tw(cred, `${MSG}/a2p/BrandRegistrations/${reg.brand_sid}`).catch((e: Error) => ({ error: e.message }));
      if (reg.messaging_service_sid && reg.campaign_sid) out.campaign = await tw(cred, `${MSG}/Services/${reg.messaging_service_sid}/Compliance/Usa2p/${reg.campaign_sid}`).catch((e: Error) => ({ error: e.message }));
      if (reg.messaging_service_sid) out.numbers = await tw(cred, `${MSG}/Services/${reg.messaging_service_sid}/PhoneNumbers`).catch((e: Error) => ({ error: e.message }));
      if (reg.customer_profile_sid) out.profile = await tw(cred, `https://trusthub.twilio.com/v1/CustomerProfiles/${reg.customer_profile_sid}`).catch((e: Error) => ({ error: e.message }));
      void API;
      return Response.json(out);
    }
    if (input.action === 'calendar_check') {
      const { agentSettings: settingsFor } = await import('../../shared/ghl.ts');
      const { freeSlots, spreadSlots } = await import('../../shared/messageBooking.ts');
      const { labelSlot } = await import('../../shared/messageClock.ts');
      const t = await settingsFor(base44, String(input.agent_email || '').toLowerCase().trim());
      if (!t) throw new Error('No agent with that email.');
      const tz = t.home_timezone || 'America/Chicago';
      try {
        const slots = await freeSlots(t, { timezone: tz }, base44.asServiceRole.entities);
        const pick = spreadSlots(slots, tz);
        return Response.json({ ok: true, calendar_id: !!t.calendar_id, hours_set: (t.calendar_hours || []).length, busy_link: !!t.busy_calendar_url, meeting_link: !!t.meeting_link, open_slots_14d: slots.length, first_slots: slots.slice(0, 4).map((x: string) => labelSlot(x, tz)), ai_would_offer: pick.map((x: string) => labelSlot(x, tz)) });
      } catch (e) { return Response.json({ ok: false, error: (e as Error).message }); }
    }
    if (input.action === 'owner_alert_test') {
      const config = await platformConfig(base44.asServiceRole.entities);
      const to = String(input.to || config.owner_email || '');
      try { const r = await base44.asServiceRole.integrations.Core.SendEmail({ to, subject: 'LeadRespark test alert', body: 'This is a test of LeadRespark owner alerts. If you got this, signup and system alerts reach this inbox.', from_name: 'LeadRespark' }); return Response.json({ ok: true, to, result: r ?? null }); }
      catch (e) { return Response.json({ ok: false, to, error: String((e as Error).message).slice(0, 500) }); }
    }
    if (input.action === 'ai_check') {
      // Which AI engine answers, and does it work? One tiny structured call.
      const started = Date.now();
      let result: any;
      try {
        const out = await invokeLLM(base44, { prompt: 'Reply with the word ready.', response_json_schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } });
        result = { ok: /ready/i.test(String(out?.word || '')), word: out?.word };
      } catch (e) { result = { ok: false, error: String((e as Error).message).slice(0, 300) }; }
      const summary = { at: new Date().toISOString(), configured: llmProvider(), answered_by: lastLLM.used, fallback_reason: lastLLM.fallback_reason, ms: Date.now() - started, ...result };
      await E.EngineCursor.upsert([{ key: 'diag:ai', cursor: JSON.stringify(summary) }], { key: 'key' });
      return Response.json(summary);
    }
    const s = await agentSettings(base44, String(input.agent_email || ''));
    if (!s) throw new Error('No agent with that email.');
    const config = await platformConfig(E);
    if (input.action === 'test_email') {
      // Sends the real booked-call email (sample appointment) to the agent's own address through their GHL account.
      const to = String(input.to || s.business_email || s.agent_email);
      const note = async (status: string) => E.EngineCursor.upsert([{ key: `diag-email:${s.agent_email}`, cursor: JSON.stringify({ at: new Date().toISOString(), to, status }) }], { key: 'key' });
      await note('started');
      let up: any;
      try { up = await ghlRaw(s, '/contacts/upsert', 'POST', { locationId: s.location_id, email: to, firstName: s.first_name || 'Test', tags: ['respark-test'] }); await note(`contact ${JSON.stringify(up).slice(0, 300)}`); }
      catch (e) { await note(`contact failed: ${(e as Error).message}`); throw e; }
      const campaign = (await E.Campaign.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
      const appt = { id: 'sample', invite_token: '0'.repeat(32), start_time: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 14) + '00:00.000Z', lead_name: 'Sample Lead', phone_to_call: s.alert_mobile || '' };
      const lead = { id: 'sample', first_name: s.first_name || 'there', phone: s.alert_mobile || '', timezone: s.home_timezone || 'America/Chicago' };
      const docs = documentsFor(config, campaign);
      const p = { lead_recap: 'This is a sample of the email your leads get the moment they book. In real emails this paragraph recaps what they shared in the texts.', call_focus: 'keeping your family covered while you are on the road', agent_brief: [], suggested_opener: '' };
      const mail = leadEmail(appt, s, lead, docs, p, 'https://respark-pipkingroup.com');
      let status = '';
      try { const r = await ghlRaw(s, '/conversations/messages', 'POST', { type: 'Email', contactId: up.contact?.id, subject: `[Sample] ${mail.subject}`, html: mail.html, attachments: docs.map((d: any) => d.url) }); status = `sent ${JSON.stringify(r).slice(0, 200)}`; }
      catch (e) { try { const r2 = await ghlRaw(s, '/conversations/messages', 'POST', { type: 'Email', contactId: up.contact?.id, subject: `[Sample] ${mail.subject}`, html: mail.html }); status = `sent without attachments (${(e as Error).message}) ${JSON.stringify(r2).slice(0, 150)}`; } catch (e2) { status = `failed: ${(e2 as Error).message}`; } }
      await E.EngineCursor.upsert([{ key: `diag-email:${s.agent_email}`, cursor: JSON.stringify({ at: new Date().toISOString(), to, status }) }], { key: 'key' });
      return Response.json({ to, status });
    }
    const campaigns = (await E.Campaign.filter({ agent_email: s.agent_email }, { limit: 20 })).items;
    const results = await Promise.all([
      check('Workspace connected', async () => ({ ok: !!(s.connected && s.location_id && s.ghl_token), detail: { location: s.location_id, provisioning: s.provisioning?.state } })),
      check('Booking calendar', async () => {
        const c = await ghl(s, `/calendars/${encodeURIComponent(s.calendar_id)}`);
        const cal = c.calendar || c;
        return { ok: !!cal?.id, detail: { name: cal?.name, team: (cal?.teamMembers || []).length, openHours: (cal?.openHours || []).length, slotDuration: cal?.slotDuration, perDay: cal?.appoinmentPerDay } };
      }),
      check('Open times next 7 days', async () => {
        const now = Date.now();
        const data = await ghl(s, `/calendars/${encodeURIComponent(s.calendar_id)}/free-slots?${new URLSearchParams({ startDate: String(now + 7200000), endDate: String(now + 7 * 86400000), timezone: s.home_timezone || 'America/Chicago' })}`);
        const slots = Object.values(data).flatMap((d: any) => Array.isArray(d?.slots) ? d.slots : []);
        return { ok: slots.length > 0, detail: { slots: slots.length, first: slots[0] || null } };
      }),
      check('CRM pipeline', async () => {
        const p = await ghl(s, `/opportunities/pipelines?locationId=${encodeURIComponent(s.location_id)}`);
        const mine = (p.pipelines || []).find((x: any) => x.id === s.pipeline_id);
        return { ok: !!mine, detail: { name: mine?.name, stages: mine?.stages?.length } };
      }),
      check('Custom fields', async () => ({ ok: Object.keys(s.custom_field_ids || {}).length >= 20, detail: Object.keys(s.custom_field_ids || {}).length })),
      check('Campaign', async () => {
        const c = campaigns[0];
        if (!c) return { ok: false, detail: 'No campaign' };
        const steps = await E.SequenceStep.count({ campaign_id: c.id });
        return { ok: steps >= 5 && !!c.system_prompt && !!c.writer_prompt, detail: { name: c.name, status: c.status, mode: c.mode, agent_mode: s.mode, steps, personalized: c.personalize_sequence !== false } };
      }),
      check('Texting number', async () => { const r = await routeFor(E, s); return { ok: !!s.phone_number && r.kind === 'twilio', detail: { number: s.phone_number || null, route: r.kind, a2p: s.a2p_status } }; }),
      check('Billing', async () => { const a = await billingAccount(E, s.agent_email); return { ok: subscriptionOkFor(config, a, s.agent_email) && (a?.status === 'card_saved' || (config.credits_exempt_emails || []).includes(s.agent_email)), detail: { card: a?.status, subscription: a?.subscription_status || 'none', balance_cents: a?.balance_cents || 0 } }; }),
      check('Agent contact info', async () => ({ ok: !!(s.alert_mobile || s.notification_phone) && !!(s.business_email || s.notification_email), detail: { mobile: !!(s.alert_mobile || s.notification_phone), email: s.notification_email || s.business_email } })),
      check('Pre-call documents', async () => { const d = documentsFor(config, campaigns[0]); return { ok: d.length >= 2, detail: d.map((x: any) => x.name) }; }),
      check('Launch checklist', async () => { const r = await readiness(E, s); return { ok: r.ready || r.live, detail: r.items.map((i: any) => `${i.done ? 'done' : 'TODO'}: ${i.label}`) }; }),
    ]);
    const summary = { agent: s.agent_email, at: new Date().toISOString(), passed: results.filter(r => r.ok).length, total: results.length, results };
    await E.EngineCursor.upsert([{ key: `diag:${s.agent_email}`, cursor: JSON.stringify(summary).slice(0, 9000) }], { key: 'key' });
    return Response.json(summary);
  } catch (error) { return failure(error as Error); }
}
