// "Trucker IUL, Aidan's voice": the 30-day text sequence Aidan Pipkin wrote for My Trucker Wealth
// (legacy_respark/functions/aidan_respark/resparkCopy.ts), carried over word for word. Every step is
// `verbatim`: the engine fills {first} and {state} and sends the copy as written; the AI writer is
// never asked to rewrite it. Where the original branched on form data the product does not hold
// (driver type, spouse, beneficiary name, goal), the neutral branch is used.
//
// Sender identity is first person ("this is Aidan"): the campaign persona is 'agent' and {agent} is
// the installing agent's first name, so another agent installing it texts as themselves.
//
// Cadence: 'standard' (the lead's own start date anchors day offsets; the shared 3-texts-per-24h cap
// applies). The legacy send window (9:00-7:30pm lead-local Mon-Sat, Sunday 12:00-7:30pm except
// AL/LA/MS/UT/RI) rides along as campaign send_rules.
import { systemPrompt as truckerSystemPrompt, knowledgeDoc as truckerKnowledge, writerPrompt as truckerWriter, sampleProfiles as truckerSamples } from './truckerSeed.ts';

export const CAMPAIGN_NAME = "Trucker IUL, Aidan's voice";
export const PRODUCT = 'Indexed universal life';
export const PROMPT_VERSION = 1;
export const AI_MODEL = 'claude-sonnet-5';

// The reply assistant still answers inbound texts; it reuses the Trucker IUL prompts in first person.
export const systemPrompt = truckerSystemPrompt;
export const knowledgeDoc = truckerKnowledge;
export const writerPrompt = truckerWriter;
export const sampleProfiles = truckerSamples;
export const stepBriefs: Record<string, string> = {};

/** Aidan's send window, applied per lead in the lead's time zone. */
export const SEND_RULES = {
  weekday: { open: '09:00', close: '19:30' },
  sunday: { open: '12:00', close: '19:30' },
  no_sunday_states: ['AL', 'LA', 'MS', 'UT', 'RI'],
};

// Legacy hour -> cadence slot (am 10:00-12:00, pm 2:30-5:30). Day offsets are the original ones.
const slotFor = (h: number) => (h < 13 ? 'am' : 'pm');

type Legacy = { day: number; h: number; label: string; text: string; kind?: string };

// ---- Aged (non-fresh) opener and the 30-day series: word for word from resparkCopy.ts ----
const OPENER_AGED = `Hey {first}, this is {agent}, the CDL financial advisor assigned to your Trucker IUL request. Tried calling a couple times, figured you were behind the wheel. You're still in {state}, right?`;
const OPENER_FRESH = `Hey {first}, this is {agent}, the CDL financial advisor assigned to the Trucker IUL request you just put in. Got it on my end. Quick one so I don't call you mid shift: you're in {state}, right?`;

const SERIES: Legacy[] = [
  { day: 1, h: 17, label: 'D2 confirm driver type + OTR/regional', text: `{first}, quick one. Are you an owner operator or driving for a company? And OTR or regional? Helps me know when you're actually parked so I'm not calling you mid shift.` },
  { day: 2, h: 12, label: 'D3 who feels it first (beneficiary)', text: `{first}, Honest question, and I ask every driver this: if the truck stopped tomorrow, how long before your family would feel it? A month? Less?` },
  { day: 3, h: 10, label: 'D4 why I do this', text: `{first}, I'll be straight about why I do this. Drivers are the backbone of this country and yall get forgotten. Crazy schedules, always working, and nobody ever sits down with you to make sure the people at home are covered if you can't be. That's the whole reason I only work with CDL holders. Still want me to look at yours?` },
  { day: 4, h: 9, label: 'D5 buried or bad timing', text: `Morning {first}. Did my texts get buried, or is this just bad timing right now? Either one's fine, just tell me which.` },
  { day: 6, h: 17, label: 'D7 health objection', text: `{first}, one thing that holds a lot of drivers back: blood pressure meds, sleep apnea, a few extra pounds. With the carriers I use for drivers, none of that is an automatic no. Is health part of what's had you on the fence?` },
  { day: 8, h: 10, label: 'D9 living benefits (works even if they already have a policy)', text: `{first}, the part most owner ops have never been told: the plan I set drivers up with has living benefits. If you get sick or hurt and can't drive, it pays you while you're alive, not just your family after. The truck note and the house note don't stop just because you did. Even if you've already got a policy, does yours do that?` },
  { day: 10, h: 9, label: 'D11 given up?', text: `{first}, have you given up on this? No hard feelings if so. I just keep thinking you filled that form out for your family, not for me, and I don't like leaving a driver hanging.` },
  { day: 13, h: 18, label: 'D14 the IUL: protection now, tax free income later', text: `{first}, the IUL you asked about does two jobs. It protects your family if something happens to you, and it builds cash you can pull as tax free income in retirement, with downside protection when the market drops. Most drivers have nothing doing that second job. I can show you how it works in 10 minutes. Want a spot this week?` },
  { day: 16, h: 12, label: 'D17 your schedule', text: `{first}, where you running this week? I work around driver schedules, not the other way around. Home time, 34 hour reset, sitting at a dock, I'll call whenever you say.` },
  { day: 19, h: 10, label: 'D20 price guess', text: `{first}, quick gut check. What do you figure something like this runs a month? Most drivers guess way high. Throw me a number and I'll tell you how close you are when we talk.` },
  { day: 23, h: 17, label: 'D24 after this run (the weight)', text: `{first}, a lot of guys tell me "I'll get to it after this run." Then it's three runs later. If something happened on the next load, your family would have to figure out the truck note, the house, all of it, while grieving. That's not a sales line, it's the real question I'd ask you on the call. Would they be alright?` },
  { day: 26, h: 9, label: 'D27 easy out: text the basics', kind: 'breakup', text: `{first}, one of my last texts on this. Would it be easier if I just texted you the basics instead of calling? I can do that too, just say the word.` },
  { day: 29, h: 11, label: 'D30 close the file', kind: 'close', text: `{first}, I'm about to close your file so I quit bugging you. Before I do, was it bad timing, or did you get it handled somewhere else? One word is fine. Either way, drive safe out there, your family needs you home.` },
];

// ---- Day-0 burst for FRESH vendor leads (minutes after the previous text; silent leads only) ----
const FRESH_BURST = [
  { offset: 20, label: 'F2 fresh nudge (+20m)', text: `{first}, one more since you just put the request in: the fastest way to get you real numbers is a 10 minute call, no pressure and no paperwork. Are you parked right now or still rolling?` },
  { offset: 240, label: 'F3 fresh reply-YES close (+4h)', text: `{first}, I'll keep it simple. Reply YES and I'll call you at this number in the next few minutes, or tell me a better time. If you'd rather I hold off for now, that's fine too, just say so.` },
];

/**
 * The SequenceStep rows. Step 1 exists in four rows: variants A and B (identical copy; the engine
 * assigns A or B to every lead) each as the aged opener and as the fresh opener (`fresh_only`).
 * Steps 2 and 3 are the fresh burst (`fresh_only`, `offset_minutes`); aged leads skip them.
 */
export function cadenceSteps(key: 'daily' | 'standard') {
  if (key !== 'standard') return [];
  const base = { cadence: 'standard', verbatim: true, brief: 'Send exactly as written.' };
  const steps: any[] = [];
  for (const variant of ['A', 'B']) {
    steps.push({ ...base, step_number: 1, variant, day_offset: 0, slot: slotFor(9), kind: 'opener', lever: 'D1 intro + state check', body: OPENER_AGED, fresh_only: false });
    steps.push({ ...base, step_number: 1, variant, day_offset: 0, slot: slotFor(9), kind: 'opener', lever: 'D1 intro + state check (fresh)', body: OPENER_FRESH, fresh_only: true });
  }
  FRESH_BURST.forEach((f, i) => steps.push({ ...base, step_number: 2 + i, variant: 'none', day_offset: 0, slot: 'am', kind: 'normal', lever: f.label, body: f.text, fresh_only: true, offset_minutes: f.offset }));
  SERIES.forEach((st, i) => steps.push({ ...base, step_number: 4 + i, variant: 'none', day_offset: st.day, slot: slotFor(st.h), kind: st.kind || 'normal', lever: st.label, body: st.text, fresh_only: false }));
  return steps;
}

export const sequence = cadenceSteps('standard');
