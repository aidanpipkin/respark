// Ethos Campaign Sender
// Sends the 3-email Ethos application sequence through GHL Conversations (email), segment-specific copy.
// Pre-send safety checks per contact: Closed anywhere -> stop; email DND/unsubscribe -> stop; inbound reply since first send -> stop.
// Body options:
//   { limit: 60, daily_cap: 500, dry_run: false }
//   { test_contact_id: "...", test_segment: "trucker", test_email_index: 0 }  -> sends one test email, touches no records
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || 'pit-85b0f99f-d8cd-4e7d-9373-5213bd2548f0';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const FROM_EMAIL = 'aidan@usnaturalinsurance.com';
const ETHOS_LINK = 'https://agents.ethoslife.com/invite/aca7f';
const PHONE = '940-368-1353';
const ADDRESS = '501 SW B ST, Bentonville, AR 72712';
const GAP_DAYS = [4, 6]; // Day 0 -> Day 4 -> Day 10
const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };

function isClosedStage(stageName: string, status: string): boolean {
  const s = (stageName || '').toLowerCase();
  return s.includes('closed') || s.includes('sold') || s.includes('policy issued') || s.includes('app submitted') || status === 'won';
}

// ---------- Copy ----------
type Email = { subject: string; paragraphs: string[]; bullets?: string[]; afterBullets?: string[] };

function brandFor(seg: string) { return seg === 'trucker' ? 'My Trucker Wealth' : 'US Natural Insurance'; }

function greet(first: string) { return first ? `Hi ${first},` : 'Hi,'; }
function nameOr(first: string, fallback: string) { return first || fallback; }

function emailCopy(seg: string, idx: number, first: string): Email {
  const link = ETHOS_LINK;
  const n = first;

  // Segment-specific hooks
  const hooks: Record<string, { e1: string[]; e2intro: string; e3intro: string; subj1: string }> = {
    trucker: {
      subj1: `${nameOr(n, 'Quick one')}${n ? ',' : ':'} your life insurance application link`,
      e1: [
        `You reached out a while back about life insurance for yourself and your family, and I wanted to make this as easy as possible for you.`,
        `As an owner-operator, you know nobody's covering your family if something happens on the road. Most drivers I talk to put this off because they think it means paperwork, a medical exam, and weeks of waiting. It doesn't anymore.`,
      ],
      e2intro: `Following up on the link I sent a few days ago. I know the schedule doesn't leave much room, so here's the short version:`,
      e3intro: `If life insurance is still on your list, the application is here and takes about 10 minutes, from the truck or a stop:`,
    },
    mortgage: {
      subj1: `${nameOr(n, 'Your')}${n ? ', your' : ''} mortgage protection application link`,
      e1: [
        `You asked about protecting your mortgage, so your family could keep the house if something happened to you. I wanted to make that as simple as possible.`,
        `Most people put this off because they expect paperwork, a medical exam, and weeks of waiting. That's the old way. Today you can get a real rate and a completed application in one sitting.`,
      ],
      e2intro: `Following up on the mortgage protection link I sent a few days ago. Here's the short version:`,
      e3intro: `If protecting the house is still on your list, the application is here and takes about 10 minutes:`,
    },
    mailer: {
      subj1: `${nameOr(n, 'Following up')}${n ? ',' : ''} the life insurance info you requested`,
      e1: [
        `You sent back a card asking for information on life insurance coverage, and I wanted to follow through the easy way.`,
        `Instead of a stack of paperwork or a long phone call, you can see your actual rate and complete the application online in about 10 minutes.`,
      ],
      e2intro: `Following up on the card you sent in and the link I emailed a few days ago. Here's the short version:`,
      e3intro: `If coverage is still on your list, the application is here and takes about 10 minutes:`,
    },
    ethos_cart: {
      subj1: `${nameOr(n, 'Your')}${n ? ', your' : ''} Ethos application is still open`,
      e1: [
        `You started a life insurance application through Ethos but didn't finish. Your progress is saved, and it only takes a few more minutes to see your rate.`,
        `I'm the licensed agent on your application, so if something stopped you (a question, a screen that didn't make sense, or just life getting busy), I can help you get across the finish line.`,
      ],
      e2intro: `Following up on your unfinished Ethos application. Here's the short version:`,
      e3intro: `If you still want to see your rate, your application is right where you left it:`,
    },
    iul: {
      subj1: `${nameOr(n, 'Your')}${n ? ', your' : ''} life insurance application link`,
      e1: [
        `You reached out about life insurance that protects your family and can build cash value over time. Step one is the same either way: get approved. I wanted to make that part easy.`,
        `Most people put this off because they expect paperwork, a medical exam, and weeks of waiting. It doesn't work that way anymore.`,
      ],
      e2intro: `Following up on the link I sent a few days ago. Here's the short version:`,
      e3intro: `If life insurance is still on your list, the application is here and takes about 10 minutes:`,
    },
  };
  const h = hooks[seg] || hooks.iul;

  if (idx === 0) {
    return {
      subject: h.subj1,
      paragraphs: [
        greet(first),
        ...h.e1,
        `You can apply online in about 10 minutes here:<br><a href="${link}">${link}</a>`,
        `Most applicants don't need a medical exam, and many get a decision the same day. It's free to apply, there's no obligation, and I'll see your application come through so I can help if anything gets stuck.`,
        `If you'd rather talk first, call or text me at ${PHONE}.`,
      ],
    };
  }
  if (idx === 1) {
    return {
      subject: `Quick one${n ? `, ${n}` : ''}: 10 minutes, no exam`,
      paragraphs: [n ? `${n},` : 'Hi,', h.e2intro],
      bullets: [
        `Apply from your phone in one sitting: <a href="${link}">${link}</a>`,
        `About 10 minutes, no appointment required`,
        `Most applicants skip the medical exam`,
        `You see your rate before you commit to anything`,
      ],
      afterBullets: [
        `If you started and got stuck, or you have a question about how much coverage makes sense, just reply here or text ${PHONE}.`,
      ],
    };
  }
  return {
    subject: `Last note from me${n ? `, ${n}` : ''}`,
    paragraphs: [
      n ? `${n},` : 'Hi,',
      `I won't keep filling your inbox. This is the last one from me on this.`,
      `${h.e3intro}<br><a href="${link}">${link}</a>`,
      `Rates are based on your age today, so waiting a year almost always costs more. If now isn't the time, no hard feelings, and I'm here whenever it is: ${PHONE}.`,
    ],
  };
}

function renderHtml(e: Email, seg: string, idx: number): string {
  const p = (t: string) => `<p style="margin:0 0 14px 0;">${t}</p>`;
  let body = e.paragraphs.map(p).join('');
  if (e.bullets) body += `<ul style="margin:0 0 14px 18px;padding:0;">${e.bullets.map(b => `<li style="margin:0 0 6px 0;">${b}</li>`).join('')}</ul>`;
  if (e.afterBullets) body += e.afterBullets.map(p).join('');
  const brand = brandFor(seg);
  const sig = idx === 0
    ? `Aidan<br>Licensed Life Insurance Agent<br>${brand}<br>${PHONE}`
    : `Aidan<br>${brand} | ${PHONE}`;
  const footer = `${ADDRESS}<br>Reply "unsubscribe" and I'll remove you from my list.`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:600px;">${body}<p style="margin:18px 0 14px 0;">${sig}</p><p style="margin:0;font-size:12px;color:#777;">${footer}</p></div>`;
}

// ---------- GHL helpers ----------
async function ghl(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

async function sendEmail(contactId: string, subject: string, html: string) {
  return ghl('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({ type: 'Email', contactId, subject, html, emailFrom: FROM_EMAIL }),
  });
}

async function setEmailDnd(contactId: string, reason: string) {
  return ghl(`/contacts/${contactId}`, {
    method: 'PUT',
    body: JSON.stringify({ dndSettings: { Email: { status: 'active', message: reason } } }),
  });
}

function chicagoDayStart(now: Date): Date {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  // Approximate CT offset using current offset
  const ctNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const offsetMs = now.getTime() - ctNow.getTime();
  return new Date(new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00`).getTime() + offsetMs);
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const now = new Date();

  // ---- Test mode ----
  if (body.test_contact_id) {
    const seg = body.test_segment || 'trucker';
    const idx = Number(body.test_email_index ?? 0);
    const c = await ghl(`/contacts/${body.test_contact_id}`);
    const first = body.test_first_name ?? (c.json?.contact?.firstName || '');
    const e = emailCopy(seg, idx, first);
    const html = renderHtml(e, seg, idx);
    if (body.preview_only) return Response.json({ subject: e.subject, html });
    const r = await sendEmail(body.test_contact_id, e.subject, html);
    return Response.json({ test: true, segment: seg, email_index: idx, subject: e.subject, ghl_status: r.status, ghl_response: r.json });
  }

  const limit = Number(body.limit ?? 60);
  const dailyCap = Number(body.daily_cap ?? 500);
  const dryRun = !!body.dry_run;

  try {
    // Load all campaign records
    const all: any[] = [];
    let skip = 0;
    while (true) {
      const items: any[] = await (base44 as any).asServiceRole.entities.EthosCampaignSend.list('created_date', 200, skip);
      all.push(...items);
      if (items.length < 200) break; skip += 200;
    }

    const dayStart = chicagoDayStart(now);
    const sentToday = all.filter(r => r.last_sent_date && new Date(r.last_sent_date) >= dayStart).length;
    const remainingCap = Math.max(0, dailyCap - sentToday);
    const due = all
      .filter(r => r.status === 'active' && r.next_email <= 2 && r.next_send_date && new Date(r.next_send_date) <= now)
      .sort((a, b) => (b.next_email - a.next_email) || a.next_send_date.localeCompare(b.next_send_date)); // follow-ups (email 2/3) first so sequences stay on schedule
    const batch = due.slice(0, Math.min(limit, remainingCap));

    const results: any = { sent_today_before: sentToday, daily_cap: dailyCap, due_total: due.length, attempted: batch.length, sent: 0, stopped_closed: 0, stopped_dnd: 0, stopped_replied: 0, unsubscribed: 0, failed: 0, completed_sequences: 0, dry_run: dryRun, errors: [] as string[] };

    const processOne = async (rec: any) => {
      const upd: any = {};
      try {
        // 1. Contact check
        const c = await ghl(`/contacts/${rec.ghl_contact_id}`);
        if (!c.ok) {
          if (c.status === 404) { upd.status = 'stopped'; upd.stop_reason = 'contact_deleted'; results.stopped_dnd++; }
          else throw new Error(`contact ${c.status}`);
        } else {
          const contact = c.json.contact || {};
          const emailDnd = contact.dnd === true || contact.dndSettings?.Email?.status === 'active';
          const tags: string[] = (contact.tags || []).map((t: string) => String(t).toLowerCase());
          if (emailDnd || tags.some(t => t.includes('unsubscribe') || t === 'dnd' || t.includes('do not email') || t.includes('do-not-email'))) {
            upd.status = 'stopped'; upd.stop_reason = 'email_dnd'; results.stopped_dnd++;
          }
          if (contact.email && contact.email.toLowerCase().trim() !== rec.email) upd.email = contact.email.toLowerCase().trim();
          if (contact.firstName && !rec.first_name) upd.first_name = contact.firstName;
        }

        // 2. Closed check
        if (!upd.status) {
          const o = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${rec.ghl_contact_id}&limit=50`);
          if (o.ok) {
            const opps = o.json.opportunities || [];
            const pipes = await pipelinesCached();
            if (opps.some((op: any) => isClosedStage(pipes.stageName[op.pipelineStageId], op.status))) {
              upd.status = 'stopped'; upd.stop_reason = 'closed'; results.stopped_closed++;
            }
          }
        }

        // 3. Reply check (only after first send)
        if (!upd.status && rec.emails_sent > 0 && rec.first_sent_date) {
          const cv = await ghl(`/conversations/search?locationId=${LOC}&contactId=${rec.ghl_contact_id}`);
          if (cv.ok) {
            const convs = cv.json.conversations || [];
            const since = new Date(rec.first_sent_date).getTime();
            const inbound = convs.find((cvv: any) => cvv.lastMessageDirection === 'inbound' && Number(cvv.lastMessageDate) > since);
            if (inbound) {
              const bodyTxt = String(inbound.lastMessageBody || '').toLowerCase();
              if (/unsubscribe|remove me|stop emailing|opt out|take me off/.test(bodyTxt)) {
                if (!dryRun) {
                  await setEmailDnd(rec.ghl_contact_id, 'Unsubscribed via email reply (Ethos campaign)');
                  try { await (base44 as any).asServiceRole.entities.GlobalSuppression.create({ email: rec.email, reason: 'unsubscribe_reply', source: 'ethos_campaign', campaign: 'ethos_application', date: now.toISOString() }); } catch (_) {}
                }
                upd.status = 'stopped'; upd.stop_reason = 'unsubscribed'; results.unsubscribed++;
              } else {
                upd.status = 'stopped'; upd.stop_reason = 'replied'; results.stopped_replied++;
              }
            }
          }
        }

        // 4. Send
        if (!upd.status) {
          const idx = rec.next_email;
          const e = emailCopy(rec.segment, idx, upd.first_name || rec.first_name || '');
          const html = renderHtml(e, rec.segment, idx);
          if (!dryRun) {
            const r = await sendEmail(rec.ghl_contact_id, e.subject, html);
            if (!r.ok) {
              const errTxt = `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`;
              results.failed++; results.errors.push(`${rec.email}: ${errTxt}`);
              // Retry 1 day out; hard-fail after 3 failures
              upd.next_send_date = new Date(now.getTime() + 86400000).toISOString();
              const prev = rec.last_error || '';
              if (prev.startsWith('FAIL3')) { upd.status = 'failed'; upd.last_error = 'FAIL3 ' + errTxt; }
              else if (prev.startsWith('FAIL2')) upd.last_error = 'FAIL3 ' + errTxt;
              else if (prev.startsWith('FAIL')) upd.last_error = 'FAIL2 ' + errTxt;
              else upd.last_error = 'FAIL ' + errTxt;
            } else {
              const mid = r.json.messageId || r.json.emailMessageId || r.json.conversationId || '';
              upd.message_ids = [...(rec.message_ids || []), mid];
              upd.emails_sent = (rec.emails_sent || 0) + 1;
              upd.last_sent_date = now.toISOString();
              if (!rec.first_sent_date) upd.first_sent_date = now.toISOString();
              upd.last_error = '';
              if (idx >= 2) { upd.next_email = 3; upd.status = 'completed'; results.completed_sequences++; }
              else { upd.next_email = idx + 1; upd.next_send_date = new Date(now.getTime() + GAP_DAYS[idx] * 86400000).toISOString(); }
              results.sent++;
            }
          } else {
            results.sent++;
          }
        }

        if (!dryRun && Object.keys(upd).length) {
          await (base44 as any).asServiceRole.entities.EthosCampaignSend.update(rec.id, upd);
        }
      } catch (err) {
        results.failed++; results.errors.push(`${rec.email}: ${String(err).slice(0, 150)}`);
      }
    };

    // Pipelines cache
    let pipesCache: any = null;
    async function pipelinesCached() {
      if (pipesCache) return pipesCache;
      const p = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
      const stageName: Record<string, string> = {};
      for (const pl of (p.json.pipelines || [])) for (const s of pl.stages) stageName[s.id] = s.name;
      pipesCache = { stageName };
      return pipesCache;
    }
    await pipelinesCached();

    // Concurrency 4
    for (let i = 0; i < batch.length; i += 4) {
      await Promise.all(batch.slice(i, i + 4).map(processOne));
    }

    results.remaining_due = due.length - batch.length;
    results.active_total = all.filter(r => r.status === 'active').length;
    results.errors = results.errors.slice(0, 10);
    return Response.json({ success: true, ...results });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
