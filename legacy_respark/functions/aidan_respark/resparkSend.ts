// Respark sender. Runs every 5 minutes. Sends the next due message of the 30-day sequence to active leads inside the
// compliance window (9:00am-7:30pm recipient local, Mon-Sat). Stops on DND, stage change, any inbound text (reply bot takes over),
// or any outbound text the bot didn't send (Aidan took over manually). All copy is first-person Aidan.
// Appointment reminders live in resparkAppointmentFlow.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//
//__COPY__//

const MAX_PER_RUN = 150;

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const force = body.force === true; // owner-authorized one-off: send the FIRST touch now, ignoring next_send_at and the send window
  const now = new Date();
  const summary: any = { dry_run: dryRun, due: 0, sent: [], stopped: [], handed_to_bot: [], manual_takeover: [], completed: [], deferred: 0, errors: [] };

  const active: any[] = await svc.filter({ status: 'active' }, 'next_send_at', 500);
  for (const L of active) {
    if (summary.sent.length >= MAX_PER_RUN) break;
    if (body.contact_id && L.ghl_contact_id !== body.contact_id) continue; // single-lead mode (used by the fresh-lead webhook for an instant first text)
    if (force) { if ((L.step || 0) !== 0 || (L.messages_sent || 0) > 0) continue; }
    else if (!L.next_send_at || new Date(L.next_send_at) > now) continue;
    summary.due++;
    const tz = L.timezone || AIDAN_TZ;
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    try {
      // stop conditions
      const c = (await ghl(`/contacts/${L.ghl_contact_id}`)).json.contact || {};
      const smsDnd = c.dnd === true || c.dndSettings?.SMS?.status === 'active';
      const tags: string[] = (c.tags || []).map((t: string) => t.toLowerCase());
      if (smsDnd || tags.some(t => t.includes('unsub') || t === 'dnd' || t.includes('stop'))) {
        log.push(`${stamp()} stopped: DND/opt-out`); summary.stopped.push(`${L.phone} dnd`);
        if (!dryRun) { await svc.update(L.id, { status: 'stopped', stop_reason: 'DND / opted out', seq_log: log }); await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Stopped']); }
        continue;
      }
      if (L.ghl_opportunity_id) {
        const opp = (await ghl(`/opportunities/${L.ghl_opportunity_id}`)).json.opportunity;
        const P = PIPES[L.pipeline_id];
        if (opp && P && (!P.newLead.includes(opp.pipelineStageId) || opp.status !== 'open')) {
          log.push(`${stamp()} stopped: Aidan moved the opportunity`); summary.stopped.push(`${L.phone} moved`);
          if (!dryRun) { await svc.update(L.id, { status: 'stopped', stop_reason: 'opportunity moved by Aidan', seq_log: log }); await removeTags(L.ghl_contact_id, ['Respark Active']); }
          continue;
        }
      }
      // Aidan texted this lead himself -> bot steps aside for good (until Aidan says resume)
      const sinceMs = Math.max(L.enrolled_at ? new Date(L.enrolled_at).getTime() : 0, Number(L.last_inbound_ms) || 0);
      const scan = await scanThread(L.ghl_contact_id, sinceMs, L.conversation || []);
      if (scan.manual.length) { summary.manual_takeover.push(L.phone); if (!dryRun) await markManualTakeover(svc, L, log, scan.manual); continue; }
      // inbound since our last text -> reply bot owns it now
      const lastOut = L.last_sms_at ? new Date(L.last_sms_at).getTime() : 0;
      const inMs = scan.inbound.length ? scan.inbound[scan.inbound.length - 1].at : 0;
      if (inMs && inMs > lastOut && (L.messages_sent || 0) > 0) {
        log.push(`${stamp()} reply detected, sequence paused for reply bot`); summary.handed_to_bot.push(L.phone);
        if (!dryRun) await svc.update(L.id, { status: 'conversing', seq_log: log });
        continue;
      }
      // compliance window
      if (!force && !inSendWindow(now, tz, L.state)) {
        const next = nextSendWindowStart(now, tz, L.state);
        summary.deferred++; summary.deferred_until = fmtLocal(next, tz);
        if (!dryRun) await svc.update(L.id, { next_send_at: next.toISOString() });
        continue;
      }
      // frequency cap: max 3 sequence texts per rolling 24h (FL/OK rule, applied to everyone)
      const recent24 = seqTextsLast24h(L.conversation || [], now);
      if (!force && recent24.length >= MAX_SEQ_TEXTS_PER_24H) {
        let next = new Date(recent24[0].getTime() + 86400000 + 5 * 60000);
        if (!inSendWindow(next, tz, L.state)) next = nextSendWindowStart(next, tz, L.state);
        summary.deferred++; summary.deferred_until = fmtLocal(next, tz); summary.capped = (summary.capped || 0) + 1;
        if (!dryRun) { await svc.update(L.id, { next_send_at: next.toISOString() }); }
        continue;
      }
      const fresh = /fresh/i.test(L.lead_status || '');
      const TRACK = fresh ? FRESH_STEPS : STEPS;
      const step = L.step || 0;
      if (step >= TRACK.length) { if (!dryRun) await svc.update(L.id, { status: 'completed', stop_reason: 'sequence finished' }); summary.completed.push(L.phone); continue; }
      const S = TRACK[step];
      const text = S.text({ first: L.first_name || 'there', group: driverGroup(L.driver_type), married: /married/i.test(L.marital_status || ''), state: L.state || '', city: L.city || '', fam: familyPhrase(L.beneficiary_relationship || '', L.marital_status || ''), goal: L.iul_goal || '', talked: talkedBefore(L.lead_status || ''), fresh });
      if (dryRun) { summary.sent.push(`${L.phone} would send ${S.label}: ${text.slice(0, 60)}...`); continue; }
      const s = await sendSms(L.ghl_contact_id, text);
      const conv: any[] = Array.isArray(L.conversation) ? [...L.conversation] : [];
      if (s.ok) {
        conv.push({ role: 'aidan_sequence', text, at: now.toISOString(), label: S.label });
        const nextStep = step + 1;
        const upd: any = { step: nextStep, messages_sent: (L.messages_sent || 0) + 1, last_sms_at: now.toISOString(), conversation: conv };
        if (nextStep < TRACK.length) {
          const enrolledAt = L.enrolled_at ? new Date(L.enrolled_at) : now;
          const base = new Date(L.next_send_at && step === 0 ? L.next_send_at : enrolledAt); // anchor day 0 = first send date
          const anchor = step === 0 ? now : (L.conversation?.find?.((m: any) => m.label === STEPS[0].label)?.at ? new Date(L.conversation.find((m: any) => m.label === STEPS[0].label).at) : base);
          const N = TRACK[nextStep];
          let nxt: Date;
          if (N.offsetMin) {
            // same-day burst: N minutes from now, but never outside texting hours (then it waits for the next window and the sender re-checks)
            nxt = new Date(now.getTime() + N.offsetMin * 60000);
            if (!inSendWindow(nxt, tz, L.state)) nxt = nextSendWindowStart(nxt, tz, L.state);
          } else {
            nxt = scheduleLocal(anchor, N.day, N.h, N.mi, tz);
            if (nxt.getTime() <= now.getTime() + 3600000) nxt = scheduleLocal(now, 1, N.h, N.mi, tz);
          }
          upd.next_send_at = nxt.toISOString();
          log.push(`${stamp()} sent ${S.label}; next ${N.label} at ${fmtLocal(nxt, tz)}`);
        } else {
          upd.status = 'completed'; upd.stop_reason = 'sequence finished, no reply'; upd.next_send_at = null;
          log.push(`${stamp()} sent ${S.label}; sequence complete`); summary.completed.push(L.phone);
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Completed - No Reply']);
        }
        await svc.update(L.id, { ...upd, seq_log: log });
        summary.sent.push(`${L.first_name} ${L.phone} ${S.label}`);
      } else {
        log.push(`${stamp()} ${S.label} FAILED ${s.err}`);
        const fail = (L.send_failures || 0) + 1;
        await svc.update(L.id, { next_send_at: new Date(now.getTime() + 45 * 60000).toISOString(), seq_log: log, send_failures: fail, ...(s.err.includes('invalid') || fail >= 3 ? { status: 'stopped', stop_reason: `send failed: ${s.err.slice(0, 80)}` } : {}) });
        summary.errors.push(`${L.phone} ${S.label} ${s.err}`);
      }
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 150)}`); }
  }

  summary.sent_count = summary.sent.length; summary.error_count = summary.errors.length;
  return Response.json({ success: true, ...summary });
});
