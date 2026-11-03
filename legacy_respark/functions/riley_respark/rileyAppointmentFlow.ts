// Respark appointment flow. Runs every 5 minutes. For every booked lead it runs the reminder sequence for the LEAD (in Riley's voice)
// and for RILEY, (GHL calendar build: no invite acceptance tracking), and handles the post-appointment outcome.
//
// LEAD (their local time):          RILEY (CT):
//   T-24h  "quick reminder, tomorrow at X" (only if booked on an earlier day, quiet 3h)   T-30m  prep brief text (file highlights, thread summary, invite status)
//          (+ nudge to accept invite if not accepted)   T+45m  wrap-up nudge if the opp is still in the Appointment stage
//   T-1h   "calling you in about an hour"
//   T-10m  "about to call, may show as a different number"
// POST-APPOINTMENT: if Riley moved the opp back to New Lead/Contacted -> treated as no-show -> lead gets a reschedule text and the
// reply bot takes over. Any other stage move -> done. Still in Appointment after 24h -> marked done, Riley nudged once.
// Modes: { dry_run: true }, { contact_id } (one lead only).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//
//__BOOKING__//

const MIN = 60000, HOUR = 3600000;

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const now = new Date();
  const summary: any = { dry_run: dryRun, checked: 0, lead_texts: [], riley_texts: [], invite_updates: [], outcomes: [], errors: [] };

  let booked: any[] = body.contact_id ? await svc.filter({ ghl_contact_id: body.contact_id }, '-created_date', 5) : await svc.filter({ status: 'booked' }, 'appointment_at', 300);
  booked = booked.filter((L: any) => L.status === 'booked' && L.appointment_at);
  let token = '';
  const tok = async () => (token = token || await outlookToken(base44));

  for (const L of booked) {
    summary.checked++;
    const tz = L.timezone || RILEY_TZ;
    const appt = new Date(L.appointment_at);
    const msTo = appt.getTime() - now.getTime();
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    const upd: any = {};
    const push = (text: string, flag: string) => ({ text, flag });
    try {
      // Invite response tracking (only while upcoming and sent)
      if (L.invite_sent && L.appointment_event_id && msTo > -HOUR && L.invite_response !== 'accepted') {
        const resp = await inviteResponse(await tok(), L.appointment_event_id, L.email);
        if (resp !== L.invite_response && resp !== 'unknown') { upd.invite_response = resp; summary.invite_updates.push(`${L.first_name}: ${resp}`); log.push(`${stamp()} invite response: ${resp}`); }
      }
      const inviteOk = (upd.invite_response || L.invite_response) === 'accepted';
      const lp = localParts(now, tz);
      const daytime = lp.h >= 8 && lp.h < 21;
      const zoom = L.meeting_mode === 'zoom' && !!L.zoom_link;

      // ---- LEAD reminders ----
      // Rules (Oct 23): light touch, never a confirmation demand.
      //  1. Nothing goes out within 3 hours of the last text we sent them; the booking confirmation counts, so a same-day booking never
      //     gets a "still good?" five minutes after "you're set".
      //  2. The day-before reminder only exists when the call is on a later calendar day than today (their time).
      //  3. At most one of the T-1h / T-10m texts: T-1h when it has been quiet long enough, otherwise just the short T-10m heads up.
      const sinceLast = now.getTime() - new Date(L.last_sms_at || 0).getTime();
      const quiet3h = sinceLast >= 3 * HOUR;
      const ap = localParts(appt, tz);
      const laterDay = Date.UTC(ap.y, ap.mo - 1, ap.d) > Date.UTC(lp.y, lp.mo - 1, lp.d);
      const dayAfter = Date.UTC(ap.y, ap.mo - 1, ap.d) - Date.UTC(lp.y, lp.mo - 1, lp.d) === 86400000;
      const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(appt);
      const whenWord = dayAfter ? `tomorrow at ${timeOnly}` : fmtLocal(appt, tz);
      let leadMsg: { text: string; flag: string } | null = null;
      if (!L.reminder_24h_sent && msTo <= 24 * HOUR && msTo > 3 * HOUR && daytime && laterDay && quiet3h) {
        leadMsg = zoom
          ? push(`Hey ${L.first_name}, Riley here. Quick reminder, we're on Zoom ${whenWord}${L.additional_attendees ? ` with ${L.additional_attendees.replace(/^(his|her|their)\s+/i, 'your ')}` : ''}. Link: ${L.zoom_link} . If anything comes up just text me and we'll move it.`, 'reminder_24h_sent')
          : push(`Hey ${L.first_name}, Riley here. Quick reminder, we're on for ${whenWord} and I'll call you at this number. If anything comes up just text me and we'll move it.`, 'reminder_24h_sent');
      } else if (!L.reminder_1h_sent && msTo <= HOUR && msTo > 20 * MIN && quiet3h) {
        leadMsg = zoom
          ? push(`${L.first_name}, Zoom in about an hour (${timeOnly}): ${L.zoom_link} . If the video gives you trouble I'll just call you at this number. Riley`, 'reminder_1h_sent')
          : push(`${L.first_name}, I'll be calling you at ${timeOnly}, about an hour from now. Talk soon. Riley`, 'reminder_1h_sent');
        if (!L.reminder_24h_sent) upd.reminder_24h_sent = true;
      } else if (!L.reminder_10m_sent && msTo <= 10 * MIN && msTo > -5 * MIN) {
        if (L.reminder_1h_sent) { upd.reminder_10m_sent = true; log.push(`${stamp()} T-10m skipped (T-1h already sent)`); }
        else if (sinceLast < 30 * MIN) { upd.reminder_10m_sent = true; log.push(`${stamp()} T-10m skipped (texted them ${Math.round(sinceLast / MIN)} min ago)`); }
        else leadMsg = zoom
          ? push(`${L.first_name}, hopping on Zoom in a few minutes: ${L.zoom_link} . Riley`, 'reminder_10m_sent')
          : push(`${L.first_name}, calling you in a few minutes. It might show up from a different number than this one, so go ahead and pick up. Riley`, 'reminder_10m_sent');
        if (!L.reminder_24h_sent) upd.reminder_24h_sent = true; if (!L.reminder_1h_sent) upd.reminder_1h_sent = true;
      }
      if (leadMsg) {
        if (dryRun) summary.lead_texts.push(`${L.first_name} ${L.phone} [${leadMsg.flag}] ${leadMsg.text.slice(0, 70)}`);
        else {
          const s = await sendSms(L.ghl_contact_id, leadMsg.text);
          if (s.ok && leadMsg.flag === 'reminder_24h_sent' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim())) { try { await sendEmail(L.ghl_contact_id, `Reminder: your call with Riley is tomorrow`, reminderEmailHtml(L, appt)); log.push(`${stamp()} reminder email sent`); } catch (_) {} }
          if (s.ok) { upd[leadMsg.flag] = true; upd.conversation = [...(L.conversation || []), { role: 'riley_bot', text: leadMsg.text, at: now.toISOString() }]; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} ${leadMsg.flag} sent`); summary.lead_texts.push(`${L.first_name} ${leadMsg.flag}`); }
          else { log.push(`${stamp()} ${leadMsg.flag} FAILED ${s.err}`); summary.errors.push(`${L.phone} ${leadMsg.flag} ${s.err}`); }
        }
      }

      // ---- RILEY prep brief (T-30m) ----
      if (!L.aidan_prep_sent && msTo <= 30 * MIN && msTo > 5 * MIN) {
        const f = L.profile || {};
        const hi = [L.driver_type, L.age ? `age ${L.age}` : '', L.marital_status, L.beneficiary_relationship ? `beneficiary ${L.beneficiary_relationship}` : '', L.iul_goal ? `goal ${L.iul_goal}` : '', f['Coverage Amount desired'] ? `wants ${f['Coverage Amount desired']}` : '', f['Health History'] ? `health: ${f['Health History']}` : '', f['Have Life Insurance'] ? `has coverage: ${f['Have Life Insurance']}` : ''].filter(Boolean).join(', ');
        const lastLead = [...(L.conversation || [])].reverse().find((m: any) => m.role === 'lead');
        const confirmed = L.lead_confirmed ? 'confirmed the time' : 'has not replied to the reminder (none was required)';
        const t = `${zoom ? 'ZOOM' : 'CALL'} IN 30 MIN: ${L.first_name} ${L.last_name || ''} ${L.phone} at ${fmtLocal(appt, RILEY_TZ, false)} (${fmtLocal(appt, tz, false)} their time).${zoom ? ` Zoom ${L.zoom_link}.` : ''}${L.additional_attendees ? ` Joining: ${L.additional_attendees}.` : ''}${L.booking_notes ? ` Your notes: ${L.booking_notes}.` : ''} ${hi}. ${L.state || ''}${L.city ? ', ' + L.city : ''}. Lead ${confirmed}. Last thing they said: "${(lastLead?.text || '').slice(0, 120)}". Full file + text thread are in the PREP note on their GHL contact.`;
        if (dryRun) summary.riley_texts.push(`prep ${L.first_name}: ${t.slice(0, 80)}`);
        else { await alertRiley(t); upd.aidan_prep_sent = true; log.push(`${stamp()} Riley prep brief sent`); summary.riley_texts.push(`prep ${L.first_name}`); }
      }

      // ---- POST appointment ----
      if (msTo <= -45 * MIN && !L.post_appt_checked) {
        const P = PIPES[L.pipeline_id];
        let stage = ''; let opp: any = null;
        if (L.ghl_opportunity_id) { opp = (await ghl(`/opportunities/${L.ghl_opportunity_id}`)).json.opportunity; stage = opp?.pipelineStageId || ''; }
        const stillAppt = P && stage === P.appointment && opp?.status === 'open';
        const backToNew = P && P.newLead.includes(stage);
        if (backToNew) {
          // Riley marked it a no-show -> offer a new time, reply bot takes over
          const t = `${L.first_name}, ${zoom ? 'looks like we missed each other on Zoom at' : 'tried you at'} ${fmtLocal(appt, tz, false)}, no worries at all, I know the schedule changes on you. Want to grab another time? Morning or afternoon usually better?`;
          if (!dryRun) { const s = await sendSms(L.ghl_contact_id, t); if (s.ok) { upd.conversation = [...(upd.conversation || L.conversation || []), { role: 'riley_bot', text: t, at: now.toISOString() }]; upd.last_sms_at = now.toISOString(); } }
          upd.status = 'conversing'; upd.appointment_at = null; upd.post_appt_checked = true;
          if (!dryRun) { await cancelBooking(await tok(), L); await removeTags(L.ghl_contact_id, ['Respark Booked']); await addTags(L.ghl_contact_id, ['Respark No-Show']); }
          upd.appointment_event_id = null; upd.prep_event_id = null;
          log.push(`${stamp()} no-show (opp moved back to New Lead); reschedule text sent`); summary.outcomes.push(`${L.first_name}: no-show, rebooking`);
        } else if (!stillAppt) {
          upd.status = 'completed'; upd.stop_reason = `appointment held, Riley moved opp (stage ${stage || 'n/a'})`; upd.post_appt_checked = true;
          if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Booked']); await addTags(L.ghl_contact_id, ['Respark Appointment Done']); }
          log.push(`${stamp()} appointment outcome handled by Riley`); summary.outcomes.push(`${L.first_name}: done`);
        } else if (!L.aidan_wrap_sent) {
          const t = `Wrap-up: your ${fmtLocal(appt, RILEY_TZ, false)} call with ${L.first_name} ${L.last_name || ''} (${L.phone}) is still sitting in the Appointment stage. If you connected, move them forward. If they no-showed, drag them back to New Lead and I'll text them for a new time within the hour.`;
          if (!dryRun) { await alertRiley(t); upd.aidan_wrap_sent = true; }
          summary.riley_texts.push(`wrap ${L.first_name}`); log.push(`${stamp()} Riley wrap-up nudge sent`);
          if (msTo <= -24 * HOUR) { upd.status = 'completed'; upd.stop_reason = 'appointment passed, no stage change in 24h'; upd.post_appt_checked = true; summary.outcomes.push(`${L.first_name}: closed out after 24h`); }
        } else if (msTo <= -24 * HOUR) {
          upd.status = 'completed'; upd.stop_reason = 'appointment passed, no stage change in 24h'; upd.post_appt_checked = true; summary.outcomes.push(`${L.first_name}: closed out after 24h`);
        }
      }

      if (!dryRun && Object.keys(upd).length) await svc.update(L.id, { ...upd, seq_log: log });
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 160)}`); }
  }
  return Response.json({ success: true, ...summary });
});
