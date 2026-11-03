// Aidan reply bot for the Respark campaign (replaces the Ashley persona). Runs every 5 minutes (or directly with { contact_id }).
// For every enrolled lead with a new inbound text it: logs the message, handles STOP, steps aside if Aidan texted manually,
// and otherwise replies AS AIDAN with the goal of booking a 30-minute phone call on Aidan's Outlook calendar (9am-9pm CT, Mon-Fri; pushes same-day and next-day slots first).
// Booking: creates the Outlook event, texts a first-person confirmation, moves the GHL opportunity to the Appointment stage, alerts Aidan.
// "Call me now": replies that Aidan will wrap up and call, alerts Aidan immediately, hands the thread to him.
// Human-touch delay: 2-6 minutes after a lead's text (1 min for fresh leads); none when GHL's Customer Replied webhook calls us with { contact_id, token }.
// Poll cost: one location-wide 'recently active conversations' list decides which threads to open, so a run is a handful of GHL calls, not one per lead.
// ASAP booking: when Aidan's calendar is clear for the next 45 minutes inside booking hours, the bot can offer 'can I call you in 15?' and book it on the spot.
// Honesty rule: the bot never claims to be a human. If asked, it says it's Aidan's number and Aidan is the one calling, and that
// he uses a tool to keep up with texts between calls.
// Simulation: POST { simulate: { text, first_name, driver_type, state, history: [...] } } returns the reply without side effects.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//
//__COPY__//

const MAX_BOT_TURNS = 14;
const REPLY_HOUR_START = 7, REPLY_HOUR_END = 22;
const BOOK_START_H = 9, BOOK_END_H = 21;   // Aidan takes booked calls until 9pm CT
const MIN_NOTICE_MIN = 60;
const REPLY_HOOK_TOKEN = 'rH7kQ2vN9xLp4sWz1bYc6tFm8gJd3eKa';   // GHL workflow "Customer Replied" -> webhook POST { contact_id, token }
const RECENT_LOOKBACK_MS = 6 * 3600000;                           // how far back the cheap change-detection list looks
const TIME_BUDGET_MS = 230000;                                    // stay under the workflow's 5-minute activity timeout
// Opt-out detection. Exact-ish one-liners ("Stop", "Stops", "stop it", "quit") OR any text that contains a clear "quit texting me" phrase.
const STOP_RE = /^\s*(stop\w*|stop (it|texting|messaging|calling|contacting)( me)?|unsubscribe|cancel|end|quit|remove( me)?|take me off|opt ?out|leave me alone|no more texts?|no more messages?|lose my number|wrong number|not me)\b[\s.!]*$/i;
const STOP_PHRASE_RE = /\b(stop (texting|messaging|contacting|calling|sending|bothering|harassing)|quit (texting|messaging|calling)|leave me alone|take me off|remove me|don'?t (text|message|contact|call) me|do not (text|message|contact|call)|no more (texts|messages)|unsubscribe|opt ?out|lose my number|f+u+c+k+ off|wrong number|wrong person|not (the right|that) person|never (signed|asked|requested))/i;
const isOptOut = (t: string) => STOP_RE.test(t) || STOP_PHRASE_RE.test(t);
// A booking is only real if the lead actually agreed. Either the bot had already offered times (so a short "yes"/"ok"/"the 4" is an answer),
// or the lead's own words name a time / say call me. Protects against a one-word reply like "Stops" being read as a yes.
const AFFIRM_RE = /\b(yes|yeah|yep|yup|ya|sure|ok|okay|sounds good|that works|works|fine|do it|book|go ahead|call me|that one|the (first|second|later|earlier) one|\d{1,2}(:\d{2})?\s*(am|pm|o'?clock)?|morning|afternoon|evening|tonight|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|now)\b/i;
// Lead's own words name a time or ask for a call (lets a first-message "call me now" / "3pm works" book without a prior offer)
const TIME_RE = /\b(\d{1,2}(:\d{2})?\s*(am|pm|o'?clock)|noon|midnight|(this |tomorrow )?(morning|afternoon|evening)|tonight|right now|call me|ring me|give me a call)\b/i;
// Marker for the one honest push-back the bot sends after a first "not interested"
const LEVEL_RE = /god forbid|devastated financially|income protection|took you off the road|couldn'?t drive/i;
function hashStr(x: string): number { let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h; }

//__BOOKING__//
// ---------- Outlook availability ----------
async function freeSlots(token: string, now: Date): Promise<Date[]> {
  const start = new Date(now.getTime() + MIN_NOTICE_MIN * 60000);
  const end = new Date(now.getTime() + 8 * 86400000);
  const ev = await graph(token, `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=start,end,showAs,isCancelled&$top=200`);
  const busy = (ev?.value || []).filter((e: any) => !e.isCancelled && e.showAs !== 'free').map((e: any) => ({ s: new Date(e.start.dateTime + 'Z').getTime(), e: new Date(e.end.dateTime + 'Z').getTime() }));
  const slots: Date[] = [];
  // ASAP slot: about 15 minutes from now (rounded up to 5), only on a booking weekday, inside booking hours, with the calendar clear for the full call.
  const asap = new Date(Math.ceil((now.getTime() + ASAP_LEAD_MIN * 60000) / 300000) * 300000);
  const ap = localParts(asap, AIDAN_TZ);
  const asapEnd = new Date(asap.getTime() + CALL_MINUTES * 60000);
  if (ap.wd >= 1 && ap.wd <= 5 && ap.h >= BOOK_START_H && (ap.h * 60 + ap.mi) <= (BOOK_END_H - 1) * 60 + 30
      && !busy.some((b: any) => asap.getTime() < b.e + 5 * 60000 && asapEnd.getTime() > b.s - 5 * 60000)) {
    (asap as any).asap = true; slots.push(asap);
  }
  for (let day = 0; day < 8; day++) {
    const dp = localParts(new Date(now.getTime() + day * 86400000), AIDAN_TZ);
    if (dp.wd === 0 || dp.wd === 6) continue;
    for (let h = BOOK_START_H; h < BOOK_END_H; h++) for (const mi of [0, 30]) {
      const s = localToUtc(dp.y, dp.mo, dp.d, h, mi, AIDAN_TZ); const e = new Date(s.getTime() + CALL_MINUTES * 60000);
      if (s.getTime() < start.getTime()) continue;
      if (busy.some((b: any) => s.getTime() < b.e + 10 * 60000 && e.getTime() > b.s - 10 * 60000)) continue;
      slots.push(s);
    }
  }
  return slots;
}
function slotMenu(slots: Date[], now: Date): Date[] {
  // Same-day / next-day first: up to 6 spread picks today, 5 tomorrow (next business day), then 2 per day for two more days.
  const byDay: Record<string, Date[]> = {};
  const asapSlot = slots.find(isAsap);
  for (const s of slots) { if (isAsap(s)) continue; const lp = localParts(s, AIDAN_TZ); const k = `${lp.y}-${String(lp.mo).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`; (byDay[k] ||= []).push(s); }
  const spread = (d: Date[], n: number) => { if (d.length <= n) return d; const out: Date[] = []; for (let i = 0; i < n; i++) out.push(d[Math.round(i * (d.length - 1) / (n - 1))]); return out.filter((x, i, a) => a.indexOf(x) === i); };
  const quotas = [6, 5, 2, 2];
  const out: Date[] = [];
  if (asapSlot) out.push(asapSlot);
  Object.keys(byDay).sort().slice(0, quotas.length).forEach((k, i) => out.push(...spread(byDay[k], quotas[i])));
  return out;
}
function dayLabel(d: Date, now: Date, tz: string): string {
  const a = localParts(d, tz), b = localParts(now, tz);
  const dn = Date.UTC(a.y, a.mo - 1, a.d), tn = Date.UTC(b.y, b.mo - 1, b.d);
  const diff = Math.round((dn - tn) / 86400000);
  return diff === 0 ? 'TODAY' : diff === 1 ? 'TOMORROW' : `in ${diff} days`;
}
function fmtNowFull(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
function profileLines(L: any): string {
  const f: Record<string, string> = { ...(L.profile || {}) };
  const base: [string, string][] = [['Name', `${L.first_name} ${L.last_name || ''}`.trim()], ['State', L.state || ''], ['City', L.city || f['City'] || ''], ['Driver type', L.driver_type || ''], ['Age', L.age || f['Age'] || ''], ['Gender', L.gender || ''], ['Marital status', L.marital_status || ''], ['Beneficiary (as they wrote it)', L.beneficiary_relationship || ''], ['Goal for the IUL', L.iul_goal || '']];
  for (const [k] of base) for (const kk of Object.keys(f)) if (kk.toLowerCase() === k.toLowerCase() || (k === 'Driver type' && kk === 'Driver Type') || (k === 'Beneficiary (as they wrote it)' && /^beneficiary/i.test(kk)) || (k === 'Goal for the IUL' && /iul goal|goals for the iul/i.test(kk)) || (k === 'Marital status' && /marital/i.test(kk))) delete f[kk];
  const lines = base.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  for (const [k, v] of Object.entries(f)) if (v) lines.push(`- ${k}: ${v}`);
  if (L.requested_at) { const days = Math.round((Date.now() - new Date(L.requested_at).getTime()) / 86400000); lines.push(`- Submitted the request about ${days} day${days === 1 ? '' : 's'} ago`); }
  return lines.join('\n') || '- (only name and phone on file)';
}

// ---------- The brain (speaks as Aidan) ----------
function systemPrompt(L: any, menu: Date[], now: Date, discloseUpfront: boolean) {
  const tz = L.timezone || AIDAN_TZ;
  const fam = familyPhrase(L.beneficiary_relationship || '', L.marital_status || '');
  const famIsName = /^[A-Z][a-z'-]+$/.test(fam);
  const group = driverGroup(L.driver_type);
  const slotLines = menu.map(s => `- ${s.toISOString()} = ${isAsap(s) ? `ASAP (Aidan can call in about ${ASAP_LEAD_MIN} minutes), ` : `${dayLabel(s, now, tz)}, `}${fmtLocal(s, tz)}${tz !== AIDAN_TZ ? ` (${fmtLocal(s, AIDAN_TZ, false)})` : ''}`).join('\n');
  const nextBiz = (() => { const d = new Date(now.getTime() + 86400000); while ([0, 6].includes(localParts(d, AIDAN_TZ).wd)) d.setTime(d.getTime() + 86400000); return d; })();
  const todayWd = localParts(now, AIDAN_TZ).wd;
  return `You are texting AS Aidan, a licensed life insurance advisor and "CDL financial advisor" based in Bentonville, Arkansas who works only with truck drivers. Aidan's brokerage serves a lot of JB Hunt, Walmart and Tyson drivers plus owner-operators. You write in first person as Aidan. Aidan reads every thread before he calls, so whatever you say, he will stand behind.

CURRENT DATE AND TIME (trust this, not your training data)
- Right now it is ${fmtNowFull(now, AIDAN_TZ)} where Aidan is (Bentonville, Arkansas, Central Time).
- For the lead it is ${fmtNowFull(now, tz)}.
- "Today" means ${new Intl.DateTimeFormat('en-US', { timeZone: AIDAN_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(now)}. "Tomorrow" means ${new Intl.DateTimeFormat('en-US', { timeZone: AIDAN_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(now.getTime() + 86400000))}.${[0, 6].includes(todayWd) || [5].includes(todayWd) ? ` The next business day Aidan books calls is ${new Intl.DateTimeFormat('en-US', { timeZone: AIDAN_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(nextBiz)}.` : ''}
- The call-time list below was pulled live from Aidan's calendar seconds ago; every slot on it is genuinely open, and anything not on it is busy or already past. Slots are marked TODAY / TOMORROW so you always know which day you're offering.

WHO YOU ARE TALKING TO
- Name: ${L.first_name} ${L.last_name || ''}. State: ${L.state || 'unknown'}. Local time zone: ${tz}. Right now it is ${fmtLocal(now, tz)} for them.
- Driver type (from their form): ${L.driver_type || 'unknown'} (${group === 'owner_op' ? 'owner-operator: no company benefits, truck payments, irregular income' : group === 'company' ? 'company driver: has basic group life through the carrier that ends when they leave or lose their med card' : 'unknown, ask'}).
- Age ${L.age || 'unknown'}, ${L.marital_status || 'marital status unknown'}, beneficiary they listed: ${L.beneficiary_relationship || 'unknown'}.
- They filled out an online form asking about a Trucker IUL (indexed universal life) for CDL drivers. ${/fresh/i.test(L.lead_status || '') ? 'They submitted the request very recently (the file shows when) and Aidan has NOT called yet; the first text went out right after the request came in. Never say you tried calling.' : talkedBefore(L.lead_status) ? `Aidan's notes say he already spoke with them once (status: ${L.lead_status}), so you two have talked before; reference that lightly, never re-pitch from zero.` : 'Aidan called a few times with no answer.'} Then he sent the texts shown in the conversation below (as himself). They have now replied. Continue the same thread naturally; do not reintroduce yourself.

THEIR FILE (everything they put on the form plus what we know; this is your rapport fuel)
${profileLines(L)}
How to use the file: the request date tells you how long they've been sitting on this ("you put this in back in August"); the call attempts tell you how many times Aidan has tried (say "I've tried you a bunch" not a number). Confirm, don't interrogate ("says here you put Katy down as beneficiary, that your wife?", "you were leaning retirement on the form, still the case?"). Pull ONE detail into a message when it makes the reply feel personal, never dump several. Use their goal, beneficiary, marital status, age range, driver type, employment, health notes and how long ago they asked to tailor what you say. If a detail looks off or they correct you, accept it and move on. Never read internal labels aloud (no "your lead status", "your file says New Lead"), never mention ads, IP, or where the lead came from.

WHY AIDAN DOES THIS (use it when it fits, in your own words, never as a speech)
CDL holders are an underserved market. Yall have unpredictable schedules, you're always working, providing for your families and being the backbone of America, so you get forgotten. Nobody reaches out to set up life insurance and retirement properly. Especially living benefits, so if a driver can't work anymore the family still has income. That's the whole reason Aidan only works with drivers.

YOUR ONE GOAL
Get a ${CALL_MINUTES}-minute phone call on the calendar. Aidan calls them at this number. Available call times (pick from this list only, present them in THEIR local time, offer at most two at a time, match morning/afternoon to what they say about their schedule):
${slotLines || '- (no open slots in the next week: ask what day/time works and set intent handoff)'}

SCHEDULING STRATEGY (speed wins; a call in 15 minutes beats a call today, a call today beats a call next week)
${menu.some(isAsap) ? '- An ASAP slot IS on the list right now, so the "call you in about 15" offer is available.' : '- THERE IS NO ASAP SLOT RIGHT NOW (Aidan is booked or outside his hours). Do NOT say "finishing up with another driver" and do NOT offer to call "in 15" or "in a few minutes". Start with a TODAY time instead.'}
- ASAP FIRST. If an ASAP slot is on the list and the lead sounds reachable right now (parked, home, off, on a reset, or just answering you easily), your first move is to get them on the phone now, in these words or close to them: "I'm actually finishing up with another driver right now. Could I call you in about 15 to get this taken care of for you?" If they say yes ("yeah", "sure", "ok", "go ahead", "call me", "sounds good"), set intent "book" with the ASAP slot's exact ISO string in book_slot. If they say they're driving, in a load, or can't right now, drop it without pushing and go to TODAY times.
- No ASAP slot on the list means Aidan is booked or it's outside his hours right now; never promise a call "in 15" in that case.
- Lead with TODAY when ASAP isn't possible or they turned it down. If there's a TODAY slot, your first offer is a TODAY time ("I've got a gap at 2:30 this afternoon, or 6 tonight after you're parked?"). Say "today", "this afternoon", "tonight", not the date.
- If they can't do today, go to TOMORROW next ("tomorrow morning at 9:30 or tomorrow at 7?"). Only move past tomorrow if they tell you they can't do either.
- Aidan takes booked calls as late as 9pm Central, so evening slots are real and often perfect for drivers who are rolling all day. Offer the evening when they mention driving, a load, or a reset.
- Still offer at most two times per message, both in THEIR local time. Match the pair to what they said (morning person vs "after I park").
- If they say "now" or "right now", that's the CALL ME NOW rule below, not a booking.
- If they name a day ("Friday"), figure out which date that is from today's date above and offer the two best slots on that day from the list; if that day has nothing, say so plainly and offer the closest day that does.

MAKE IT MATTER (this is the heart of every reply)
- The person they named on the form is ${famIsName ? `${fam} (use the name: "what would ${fam} do", "is ${fam} the one who'd have to figure it out")` : `"${fam}" (no name on file; if they mention a name, start using it)`}. Every reply should connect back to that person in some way, even if it's a few words.
- Ask emotion-based questions, not product questions. Not "do you want coverage" but "if the check stopped next month, how long before ${fam} would feel it?" "Who handles the truck note if you can't drive?" "At 65, still in the seat or home with ${fam}?" "What made you fill the form out that night?"
- Let them feel the weight of doing nothing, in one honest line, never a lecture: no policy means ${fam} carries the truck note, the house and the bills alone, while grieving. No living benefits means a wreck or a diagnosis that takes you off the road also takes the income with it. Say it once, plainly, then ask a question. Real, not scare tactics, and never disrespectful.
- Use their own answers as the reason to talk: "you said this is for ${fam}, so let's make sure it's actually done." Tie the booking to the person, not the product.

HOW AIDAN TEXTS
- Like a real guy texting from his phone between calls: 1-3 short sentences, under 300 characters, plain words, contractions, "yall" is fine, no emojis, no bullet lists, no links, no signatures (they know it's Aidan).
- Confirms what's on the form instead of asking cold: "Says here you're an owner operator, is that accurate?" "You're still in ${L.state || 'the same state'}, right?" "OTR or regional?"
- Warm, confident, zero pressure. Genuinely likes drivers. Acknowledges what they said in a few words ("Awesome", "Makes sense", "Gotcha"), then asks ONE simple question they can answer in a word or two.
- Trucker-aware language when it fits (behind the wheel, parked, home time, reset, med card, dock). Never fake CB slang.
- If they say they're driving: one line, ask when they'll be parked.
- Owner-ops: lean on the truck note, no 401k match, living benefits paying them if they can't drive. Company drivers: the policy through work ends when they leave or lose the med card; this one is theirs for life.
- When they answer a question from the sequence (A or B, yes/no, OTR/regional, family vs retirement), reflect it back in one clause so they feel heard, then go for a time.

IF THEY ASK WHO THIS IS (not a bot question): "Aidan, the CDL financial advisor on the Trucker IUL request you put in" plus roughly when they put it in (from the file), then one easy question. Do NOT bring up the texting tool unless they actually ask whether this is a bot, automated or AI.

HONESTY (non-negotiable)
- Never claim to be a human, never say "I'm not a bot", never say "no, this is Aidan" to a bot question. If they ask whether this is a bot, automated, AI, or a real person, answer in Aidan's voice with this idea: "It's my number and I'm the one who'll be calling you. I use a tool that helps me keep up with texts between calls, so if a reply comes back quick, that's why." Then move on with one question.${discloseUpfront ? '\n- This lead is in a state with bot-disclosure rules: in your FIRST reply, work in one plain clause that you use an assistant tool to keep up with texts between calls.' : ''}
- Never invent what Aidan is doing at this exact moment (on a call, driving, busy). The one approved exception is the ASAP opener ("finishing up with another driver") and only when an ASAP slot is on the list, because that list comes straight from his live calendar. Otherwise you only know his open calendar times.

HARD RULES (licensing and compliance)
- Never quote a price, premium, rate, dollar amount, "$1/day", percentage, or return. If asked about cost, say it depends on age, health and the amount, that you can run real numbers in a few minutes on the call, and offer a time. If they guess a number (the sequence asks them to), say you'll tell them how close they are on the call.
- Never say anyone is approved, qualifies, or guaranteed. No medical, tax or legal opinions. You can say the carriers you use are used to drivers and things like blood pressure or sleep apnea often are not automatic no's.
- Never name specific insurance carriers or products beyond "the IUL you asked about" or "coverage" or "living benefits".
- Never ask for sensitive data (SSN, bank, medical details, date of birth). Confirming the phone number for the call is fine.
- Already has coverage: never argue or knock the policy. Pivot to the two things most policies don't do: (1) living benefits, meaning it pays THEM while alive if a serious illness or injury takes them off the road, and (2) tax free income in retirement from the cash value, with downside protection when the market drops. Ask one question like "does yours pay you anything if you can't drive, or only ${fam} after?" or "is it through work or in your own name?" Then offer a quick call to make sure what they have actually does both jobs, and that it goes with them if they change jobs or lose the med card. You can say "tax free income in retirement" and "living benefits" in general terms; no numbers, no promises.
- Not interested / "no" / "I'm good" / "not right now": do NOT close the file on the first no. Level with them once, like a human who actually means it, in your own words along these lines: "I get it, most people aren't, and I'm not going to chase you. Let me just ask you straight though. If you passed away today, God forbid, would ${fam} be devastated financially? And if you got in a wreck tomorrow and couldn't drive anymore, do you have income protection so the people who depend on you still have income?" Use ${famIsName ? `${fam}'s name` : 'their family'}, keep it under 300 characters, one or two of those questions at most, no pitch, then stop and let them answer. Set intent "continue". If they answer honestly (even "no I don't"), that's the opening: acknowledge it in a few words and offer a time (ASAP or TODAY first).
- Second no (they've already seen your level-with-them message in the conversation and still say no), or any firm "stop texting me" / "leave me alone" / "remove me" / "not interested" with heat: respect it. Thank them in one line, say you'll close their file, wish them safe travels, set intent "not_interested". Never a third attempt.
- Wrong number / never asked / not a driver: apologize in one line, set intent "wrong_person".
- CALL ME NOW ("call me", "call me now", "just call", "ring me", "can you call"): if an ASAP slot is on the list, set intent "book" with the ASAP slot (the system sends the "I'll call you in about 15" confirmation). If there is no ASAP slot, set intent "handoff" with reason "wants a call now" and reply only: "Give me a few minutes to wrap up what I'm in the middle of and I'll call you at this number." Do not offer times in that message.
- If they ask something only the licensed agent should answer in writing, seem upset, or you've gone back and forth many times without a booking: set intent "handoff" with a reason, and say you'll pick this up personally in a bit.

BOOKING
- Only set intent "book" when the lead has clearly agreed to a call AND picked (or accepted) a specific time you offered IN AN EARLIER MESSAGE. The message where you first propose a time (including the ASAP "call you in 15" offer) is always intent "continue"; you wait for their yes. A one-word or ambiguous reply ("Stops", "ok", "k", "what", "?") is NOT agreement; ask a short clarifying question instead. Anything that reads like "stop", "quit texting", "leave me alone" means they are out: set intent "not_interested" with a one-line respectful close, never a booking.
- When they agree to one of the specific times you offered, set intent "book" and put that slot's exact ISO string from the list in book_slot. Never book a time that is not in the list. If they propose a time not in the list, offer the closest one or two from the list.
- When you set intent "book", your reply text is replaced by a system confirmation, so just write a short friendly line.
${L.status === 'booked' && L.appointment_at ? `- They already have a call booked for ${fmtLocal(new Date(L.appointment_at), tz)}${L.invite_sent ? ` and a calendar invite went to ${L.email} from aidan@usnaturalinsurance.com (status: ${L.invite_response || 'not accepted yet'}); if they can't find it, tell them to check spam/junk and that accepting it just puts it on their phone, the call happens either way` : ''}. If they're confirming ("yes", "sounds good", "see you then") reply with one short warm line, no new question. If they want to move it set intent "reschedule" (and offer two new times); if they want to cancel set intent "cancel_appointment"; otherwise just answer briefly.` : ''}

Respond ONLY with JSON: {"reply": string, "intent": "continue"|"book"|"handoff"|"not_interested"|"wrong_person"|"reschedule"|"cancel_appointment", "book_slot": string, "handoff_reason": string, "summary": string}
"summary" = one line about where this conversation stands, for Aidan to read before he calls.`;
}
function sayWhen(x: Date, now: Date, tz: string): string { const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(x); const dl = dayLabel(x, now, tz); return dl === 'TODAY' ? `today at ${t}` : dl === 'TOMORROW' ? `tomorrow at ${t}` : fmtLocal(x, tz); }
function offerTwo(L: any, menu: Date[], now: Date, lead: string): string { const tz = L.timezone || AIDAN_TZ; const picks = menu.filter(x => !isAsap(x)).slice(0, 2); return picks.length ? `${lead} I can give you a quick call ${picks.map(x => sayWhen(x, now, tz)).join(' or ')}. Which works better for you?` : `${lead} What day and time are you usually parked? I'll work around your schedule.`; }
async function askBot(base44: any, L: any, menu: Date[], now: Date, discloseUpfront: boolean) {
  const convo: any[] = Array.isArray(L.conversation) ? L.conversation : [];
  const history = convo.slice(-20).map((m: any) => `${m.role === 'lead' ? String(L.first_name).toUpperCase() : 'AIDAN'}: ${m.text}`).join('\n');
  const r = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt: `${systemPrompt(L, menu, now, discloseUpfront)}\n\nCONVERSATION SO FAR (oldest first):\n${history}\n\nWrite Aidan's next text message as JSON.`,
    response_json_schema: { type: 'object', properties: { reply: { type: 'string' }, intent: { type: 'string' }, book_slot: { type: 'string' }, handoff_reason: { type: 'string' }, summary: { type: 'string' } }, required: ['reply', 'intent'] },
  });
  const out = typeof r === 'string' ? JSON.parse(r) : r;
  out.reply = String(out.reply || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  if (!out.book_slot || out.book_slot === 'null') out.book_slot = '';
  if (!out.handoff_reason || out.handoff_reason === 'null') out.handoff_reason = '';
  // Safety net on the honesty rule: never let a flat "not a bot" / "real person" claim go out.
  if (/\b(not a bot|i'?m not a bot|i am not a bot|not automated|not an? ai|i'?m (a )?real person|real human|i'?m human)\b/i.test(out.reply)) {
    out.reply = `It's my number and I'm the one who'll be calling you. I use a tool that helps me keep up with texts between calls, so if a reply comes back quick, that's why. When are you usually parked?`;
  }
  // First "no" never closes the file: level with them once (Aidan's words), then let them answer. Only a second no (or heat / STOP, caught earlier) ends it.
  if (out.intent === 'not_interested' && !convo.some((x: any) => x.role === 'aidan_bot' && LEVEL_RE.test(x.text || ''))) {
    const fam = familyPhrase(L.beneficiary_relationship || '', L.marital_status || '');
    out.reply = `I get it ${L.first_name}, most people aren't, and I'm not going to chase you. Let me just ask you straight though: if you passed away today, God forbid, would ${fam} be devastated financially? And if a wreck took you off the road for good, do you have income protection so the people who depend on you still have income?`;
    out.intent = 'continue'; out.guard = 'first no: leveled with them instead of closing the file';
  }
  // No ASAP slot -> the bot must not promise a call "in 15". Swap in a plain today/tomorrow offer instead.
  if (!menu.some(isAsap) && /finishing up with another driver|in about 15|in 15 (min|to)|call you in 15|in a few minutes/i.test(out.reply)) {
    out.reply = offerTwo(L, menu, now, `${L.first_name},`); out.guard = 'no ASAP slot: replaced 15-minute promise with a time offer';
    if (out.intent === 'book') out.intent = 'continue';
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const now = body.simulate?.now ? new Date(body.simulate.now) : new Date();

  if (body.simulate) {
    const S = body.simulate;
    const first = S.first_name || 'Mike';
    const st = S.state || 'Texas';
    const L: any = { first_name: first, last_name: S.last_name || '', state: st, timezone: tzForState(st), driver_type: S.driver_type || 'Company Driver (W-2)', age: S.age || '44', marital_status: S.marital_status || 'Married', beneficiary_relationship: S.beneficiary_relationship || 'Spouse', iul_goal: S.iul_goal || '', phone: '+15555550100', status: S.status || 'conversing', appointment_at: S.appointment_at, lead_status: S.lead_status || '',
      conversation: [...(S.history || [{ role: 'aidan_sequence', text: STEPS[0].text({ first, group: driverGroup(S.driver_type), married: true, state: st, fresh: /fresh/i.test(S.lead_status || '') }) }]), { role: 'lead', text: S.text }] };
    let menu: Date[] = [];
    try { menu = slotMenu(await freeSlots(await outlookToken(base44), now), now); } catch (e) { menu = []; }
    const out = await askBot(base44, L, menu, now, AI_DISCLOSE_STATES.includes(st.toLowerCase()));
    return Response.json({ simulate: true, now: fmtLocal(now, AIDAN_TZ), slots_offered: menu.map(s => (isAsap(s) ? 'ASAP ' : '') + fmtLocal(s, L.timezone)), ...out });
  }

  // Test hook: book a specific lead record into a specific slot (or the first open slot) with full side effects.
  if (body.test_book && body.test_book.contact_id) {
    const L = (await svc.filter({ ghl_contact_id: body.test_book.contact_id }, '-created_date', 1))[0];
    if (!L) return Response.json({ error: 'no ResparkLead for that contact' }, { status: 404 });
    const token = await outlookToken(base44);
    const menu = slotMenu(await freeSlots(token, now), now);
    const slot = body.test_book.slot ? new Date(body.test_book.slot) : menu[0];
    if (!slot) return Response.json({ error: 'no open slot' }, { status: 400 });
    const tz = L.timezone || AIDAN_TZ;
    const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim());
    const convo: any[] = [...(L.conversation || []), { role: 'lead', text: body.test_book.lead_text || 'Yeah that time works for me', at: now.toISOString() }];
    const replyText = confirmationText(L, slot, hasEmail);
    await cancelBooking(token, L);
    const bk = await createBooking(token, L, slot, [...convo, { role: 'aidan_bot', text: replyText }]);
    const P = PIPES[L.pipeline_id];
    if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.appointment }) });
    await addNote(L.ghl_contact_id, `RESPARK BOOKED (test hook) ${fmtLocal(slot, AIDAN_TZ)}. Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent'}.`);
    const s = await sendSms(L.ghl_contact_id, replyText);
    convo.push({ role: 'aidan_bot', text: replyText, at: now.toISOString() });
    await alertAidan(`BOOKED (Respark bot, as you): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${fmtLocal(slot, AIDAN_TZ)} | ${L.driver_type || ''} ${L.state || ''} | Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent, no email'} | Prep block is on your calendar 15 min before with the full file and thread.`);
    await svc.update(L.id, { status: 'booked', appointment_at: slot.toISOString(), appointment_event_id: bk.eventId, prep_event_id: bk.prepEventId, invite_sent: bk.inviteSent, invite_response: bk.inviteSent ? 'none' : 'no_email', conversation: convo, last_sms_at: now.toISOString(), reminder_24h_sent: false, reminder_1h_sent: false, reminder_10m_sent: false, aidan_prep_sent: false, aidan_wrap_sent: false, post_appt_checked: false, lead_confirmed: false, seq_log: [...(L.seq_log || []), `${stamp()} TEST BOOK ${fmtLocal(slot, AIDAN_TZ)}`] });
    return Response.json({ booked: fmtLocal(slot, tz), event_id: bk.eventId, prep_event_id: bk.prepEventId, invite_sent: bk.inviteSent, sms: s, confirmation: replyText });
  }

  const dryRun = body.dry_run === true;
  const summary: any = { dry_run: dryRun, checked: 0, scanned_threads: 0, replied: [], booked: [], handoffs: [], stopped: [], manual_takeover: [], deferred: [], waiting: [], errors: [] };

  // Entry points:
  //  (a) scheduled poll (no body): every enrolled lead, but only threads GHL says changed recently get opened (see below)
  //  (b) GHL "Customer Replied" workflow webhook: { contact_id | contactId | contact.id, token } -> that one lead, right now (instant speed-to-lead)
  //  (c) owner/internal: { contact_id, immediate }
  const hookContact = body.contact_id || body.contactId || body.contact?.id || (body.token ? body.id : '');
  const viaHook = !!(hookContact && body.token);
  if (hookContact && body.token && body.token !== REPLY_HOOK_TOKEN) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const immediate = body.immediate === true || viaHook;

  let leads: any[] = [];
  if (hookContact) leads = await svc.filter({ ghl_contact_id: hookContact }, '-created_date', 5);
  else for (const st of ['conversing', 'active', 'booked', 'handoff']) leads.push(...await svc.filter({ status: st }, '-updated_date', 500));

  // Cheap change detection for the poll: one location-wide conversation list sorted by last message (a few pages) instead of
  // one GHL search per lead. A thread is opened only if GHL shows activity after what we already processed. Once an hour
  // (minute < 5) we fall back to opening every thread, so nothing can hide behind a missed page.
  let recent: Map<string, { d: number; dir: string }> | null = null;
  const fullScan = hookContact || localParts(now, AIDAN_TZ).mi < 5 || body.full_scan === true;
  if (!fullScan) {
    try {
      recent = new Map();
      const lookback = now.getTime() - RECENT_LOOKBACK_MS;
      for (let page = 0, sa: any = null; page < 8; page++) {
        const q = `/conversations/search?locationId=${LOC}&sortBy=last_message_date&sort=desc&limit=100` + (sa ? `&startAfterDate=${sa}` : '');
        const r = (await ghl(q, {}, '2021-04-15')).json; const list: any[] = r.conversations || [];
        for (const cv of list) { const d = Number(cv.lastMessageDate) || 0; if (cv.contactId && d > (recent.get(cv.contactId)?.d || 0)) recent.set(cv.contactId, { d, dir: String(cv.lastMessageDirection || '') }); }
        const last = list[list.length - 1]; if (!list.length || !last || (Number(last.lastMessageDate) || 0) < lookback) break;
        sa = last.lastMessageDate;
      }
      summary.recent_threads = recent.size;
    } catch (e) { recent = null; summary.errors.push(`recent-scan failed, full scan: ${String(e).slice(0, 100)}`); }
  }

  let token = ''; let menu: Date[] | null = null;
  const getMenu = async () => { if (menu) return menu; token = token || await outlookToken(base44); menu = slotMenu(await freeSlots(token, now), now); return menu; };
  const started = Date.now();

  for (const L of leads) {
    if (Date.now() - started > TIME_BUDGET_MS) { summary.time_budget_hit = true; break; }
    if ((L.messages_sent || 0) === 0 && L.status === 'active') continue;
    if (L.status === 'manual' || L.status === 'stopped' || L.status === 'completed') continue;
    summary.checked++;
    const tz = L.timezone || AIDAN_TZ;
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    try {
      const since = Math.max(Number(L.last_inbound_ms) || 0, L.enrolled_at ? new Date(L.enrolled_at).getTime() : 0);
      if (recent) {
        const r = recent.get(L.ghl_contact_id); const lastSms = L.last_sms_at ? new Date(L.last_sms_at).getTime() : 0;
        if (!r || r.d <= Math.max(since, lastSms)) continue;                                   // nothing new in this thread
        if (r.dir === 'outbound' && r.d - lastSms < 120000) continue;                            // latest message is the text we just sent (GHL stamps it a moment after we do)
      }
      summary.scanned_threads++;
      const { inbound, manual } = await scanThread(L.ghl_contact_id, since, L.conversation || []);
      // Aidan jumped into the thread himself -> the bot goes quiet on this lead
      if (manual.length) { summary.manual_takeover.push(L.phone); if (!dryRun) await markManualTakeover(svc, L, log, manual); continue; }
      if (!inbound.length) continue;
      // Human-touch delay before answering: webhook/immediate = none (GHL already waited a minute), fresh leads 1 min, everyone else 2-6 min.
      const lastInAt = inbound[inbound.length - 1].at;
      const delayMin = immediate ? 0 : /fresh/i.test(L.lead_status || '') ? 1 : 2 + (hashStr(L.ghl_contact_id + lastInAt) % 5);
      if (now.getTime() - lastInAt < delayMin * 60000) { summary.waiting.push(`${L.phone} (${delayMin}m)`); continue; }
      const lp = localParts(now, tz);
      if (lp.h < REPLY_HOUR_START || lp.h >= REPLY_HOUR_END) { summary.deferred.push(L.phone); continue; }
      const convo: any[] = Array.isArray(L.conversation) ? [...L.conversation] : [];
      for (const m of inbound) convo.push({ role: 'lead', text: m.text, at: new Date(m.at).toISOString() });
      const lastMs = lastInAt;
      const latestText = inbound.map(m => m.text).join(' ');
      const firstReply = (L.reply_count || 0) === 0;
      const base: any = { conversation: convo, last_inbound_ms: lastMs, last_inbound_at: new Date(lastMs).toISOString(), reply_count: (L.reply_count || 0) + inbound.length };

      if (inbound.some(m => isOptOut(m.text))) {
        log.push(`${stamp()} lead texted STOP; DND set`); summary.stopped.push(`${L.phone} STOP`);
        if (!dryRun) {
          await ghl(`/contacts/${L.ghl_contact_id}`, { method: 'PUT', body: JSON.stringify({ dndSettings: { SMS: { status: 'active', message: 'Replied STOP to Respark text' } } }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Stopped', 'SMS Opt-Out']);
          await svc.update(L.id, { ...base, status: 'stopped', stop_reason: 'lead replied STOP', next_send_at: null, seq_log: log });
        }
        continue;
      }
      if (L.status === 'handoff') {
        log.push(`${stamp()} new text while in handoff: "${latestText.slice(0, 60)}"`);
        if (!dryRun) { await alertAidan(`${L.first_name} ${L.last_name || ''} (${L.phone}) texted again, you have this one: "${latestText.slice(0, 200)}"`); await svc.update(L.id, { ...base, seq_log: log }); }
        continue;
      }

      const discloseUpfront = AI_DISCLOSE_STATES.includes((L.state || '').toLowerCase()) && (L.ashley_turns || 0) === 0;
      const m = await getMenu();
      const out = await askBot(base44, { ...L, conversation: convo }, m, now, discloseUpfront);
      let intent = String(out.intent || 'continue');
      let replyText = out.reply;
      const upd: any = { ...base, intent, ashley_turns: (L.ashley_turns || 0) + 1, next_send_at: null };
      const menuIso = new Set(m.map(s => s.toISOString()));
      if (L.status === 'booked' && /^(y(es|ep|eah|up)|ok(ay)?|sounds good|still good|see you|confirmed|we'?re good|i'?m good|good to go|10-4|all good)\b/i.test(latestText.trim()) && intent === 'continue') { upd.lead_confirmed = true; log.push(`${stamp()} lead confirmed the appointment`); }
      if (L.status === 'booked' && intent === 'continue') upd.status = 'booked';

      // Guard: no booking unless the lead actually agreed (bot offered times before, or their words name a time / say yes)
      const botOfferedBefore = convo.some((x: any) => x.role === 'aidan_bot' && x.at && new Date(x.at).getTime() < lastMs);
      const leadNamedTime = TIME_RE.test(latestText);
      // No booking unless the lead agreed to something already offered, or named a time / asked for a call themselves
      if (intent === 'book' && !(botOfferedBefore || leadNamedTime)) {
        log.push(`${stamp()} bot wanted to book off "${latestText.slice(0, 40)}" before offering a time; downgraded to a two-time offer`);
        intent = 'continue'; upd.intent = intent;
        replyText = offerTwo(L, m, now, `Gotcha ${L.first_name}.`);
      }
      if (intent === 'book' && out.book_slot && menuIso.has(new Date(out.book_slot).toISOString())) {
        const slot = m.find(x => x.toISOString() === new Date(out.book_slot).toISOString())!;
        const asapBook = isAsap(slot);
        const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim());
        replyText = confirmationText(L, slot, hasEmail);
        if (!dryRun) {
          token = token || await outlookToken(base44);
          await cancelBooking(token, L);
          const bk = await createBooking(token, L, slot, [...convo, { role: 'aidan_bot', text: replyText }]);
          upd.appointment_event_id = bk.eventId; upd.prep_event_id = bk.prepEventId; upd.invite_sent = bk.inviteSent; upd.invite_response = bk.inviteSent ? 'none' : 'no_email';
          const P = PIPES[L.pipeline_id];
          if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.appointment }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Booked']);
          await addNote(L.ghl_contact_id, `RESPARK BOOKED ${fmtLocal(slot, AIDAN_TZ)} (${fmtLocal(slot, tz)} lead time). Booked by the Respark text bot in Aidan's voice. Invite ${bk.inviteSent ? 'sent to ' + L.email : 'NOT sent (no email on file)'}. Summary: ${out.summary || ''}\nThread:\n${convo.slice(-12).map((m: any) => `${m.role === 'lead' ? L.first_name : 'Aidan'}: ${m.text}`).join('\n')}`);
          await alertAidan(asapBook
            ? `CALL IN ${ASAP_LEAD_MIN} MIN (${fmtLocal(slot, AIDAN_TZ, false)}): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${L.driver_type || ''} ${L.state || ''} | They said yes to "finishing up with another driver, can I call you in 15?" so they're expecting you. ${out.summary || ''}\nLast texts:\n${convo.slice(-6).map((x: any) => `${x.role === 'lead' ? L.first_name : 'You'}: ${x.text}`).join('\n')}`
            : `BOOKED (Respark bot, as you): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${fmtLocal(slot, AIDAN_TZ)} | ${L.driver_type || ''} ${L.state || ''} | Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent, no email'} | ${out.summary || ''} | Prep block is on your calendar 15 min before with the full file and thread.`);
        }
        upd.status = 'booked'; upd.appointment_at = slot.toISOString(); upd.reminder_24h_sent = asapBook; upd.reminder_1h_sent = asapBook; upd.reminder_10m_sent = false; upd.aidan_prep_sent = false; upd.post_appt_checked = false; upd.lead_confirmed = asapBook;
        log.push(`${stamp()} booked ${fmtLocal(slot, AIDAN_TZ)}${asapBook ? ' (ASAP, call in 15)' : ''}`); summary.booked.push(`${L.first_name} ${L.phone} ${fmtLocal(slot, AIDAN_TZ)}`);
      } else if (intent === 'book') { intent = 'continue'; upd.intent = intent; }

      if (intent === 'cancel_appointment' && L.status === 'booked') {
        if (!dryRun) {
          token = token || await outlookToken(base44); await cancelBooking(token, L);
          const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.newLead[0] }) });
          await alertAidan(`${L.first_name} ${L.last_name || ''} (${L.phone}) CANCELLED the call that was ${fmtLocal(new Date(L.appointment_at), AIDAN_TZ)}. ${out.summary || ''}`);
        }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; upd.prep_event_id = null; log.push(`${stamp()} appointment cancelled by lead`);
      }
      if (intent === 'reschedule' && L.status === 'booked') {
        if (!dryRun) { token = token || await outlookToken(base44); await cancelBooking(token, L); }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; upd.prep_event_id = null; log.push(`${stamp()} lead wants to reschedule; old event removed`);
      }
      if (intent === 'not_interested') {
        upd.status = 'stopped'; upd.stop_reason = 'not interested (told the bot)';
        if (!dryRun) { const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.notInterested }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Not Interested']); }
        log.push(`${stamp()} not interested`); summary.stopped.push(`${L.phone} not interested`);
      }
      if (intent === 'wrong_person') {
        upd.status = 'stopped'; upd.stop_reason = 'wrong number / not a driver';
        if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Wrong Number']); }
        log.push(`${stamp()} wrong person`); summary.stopped.push(`${L.phone} wrong person`);
      }
      if (intent === 'handoff' || (intent === 'continue' && upd.ashley_turns >= MAX_BOT_TURNS)) {
        upd.status = 'handoff';
        const wantsCall = /call now|wants a call/i.test(out.handoff_reason || '');
        if (!dryRun) await alertAidan(`${wantsCall ? 'CALL THEM NOW' : 'HANDOFF'} ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${L.driver_type || ''} ${L.state || ''}\nWhy: ${out.handoff_reason || 'conversation needs you'}\nThey said: "${latestText.slice(0, 160)}"\nBot replied as you: "${replyText.slice(0, 120)}"\nYou own this thread now (GHL).`);
        log.push(`${stamp()} handed off to Aidan: ${out.handoff_reason || ''}`); summary.handoffs.push(`${L.first_name} ${L.phone}: ${out.handoff_reason || ''}`);
      }
      if (!upd.status) upd.status = 'conversing';

      if (replyText) {
        if (dryRun) summary.replied.push(`${L.first_name} ${L.phone} [${intent}] "${latestText.slice(0, 40)}" -> "${replyText.slice(0, 80)}"`);
        else {
          const s = await sendSms(L.ghl_contact_id, replyText);
          if (s.ok) { convo.push({ role: 'aidan_bot', text: replyText, at: now.toISOString() }); upd.conversation = convo; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} bot as Aidan [${intent}]: "${replyText.slice(0, 70)}"`); summary.replied.push(`${L.first_name} ${L.phone} [${intent}]`); }
          else { log.push(`${stamp()} bot reply FAILED ${s.err}`); summary.errors.push(`${L.phone} send ${s.err}`); }
        }
      }
      if (firstReply && !dryRun && intent !== 'handoff' && intent !== 'book') await alertAidan(`Respark REPLY from ${L.first_name} ${L.last_name || ''} (${L.phone}, ${L.driver_type || ''} ${L.state || ''}): "${latestText.slice(0, 160)}" | Bot is answering as you. Text them yourself from GHL any time and it goes quiet. ${out.summary || ''}`);
      if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Replied']); await svc.update(L.id, { ...upd, seq_log: log }); }
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 200)}`); }
  }
  summary.replied_count = summary.replied.length;
  return Response.json({ success: true, ...summary });
});
