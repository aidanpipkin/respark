// 30-day Respark sequence copy. Sender identity: Aidan himself (first person). 14 touches: daily the first week, then spacing out.
// Rules: no links, no prices, no license number, no opt-out line (leads opted in), one easy question per text, built to pull a reply.
// Voice: casual, confirms what's on the form, "yall", plain words, no emojis.
// Emotional weight: every text ties back to the person they named on the form (by name when we have it) and what it would
// actually mean for that person if the driver did nothing. Real, not scare tactics. If they already have coverage, the angle
// is living benefits and tax free retirement income, never "your policy is bad".
export type Ctx = { first: string; group: 'owner_op' | 'company' | 'unknown'; married: boolean; state: string; city?: string; fam?: string; goal?: string; talked?: boolean; fresh?: boolean };
export type Step = { day: number; h: number; mi: number; label: string; text: (ctx: Ctx) => string; offsetMin?: number };  // offsetMin: send N minutes after the previous text (same-day bursts), instead of day/h/mi

const famOf = (c: Ctx) => c.fam || (c.married ? 'your wife and kids' : 'your family');
// true when fam is a person's name (one capitalized word) rather than a phrase like "your family"
const famIsName = (c: Ctx) => !!c.fam && /^[A-Z][a-z'-]+$/.test(c.fam);
const placeOf = (c: Ctx) => c.city || c.state || 'the same state';
const goalKind = (g?: string) => /retire/i.test(g || '') ? 'retirement' : /famil|protect|income|final|burial/i.test(g || '') ? 'family' : '';

export const STEPS: Step[] = [
  { day: 0, h: 9, mi: 30, label: 'D1 intro + state check', text: (c) =>
    c.fresh
      ? `Hey ${c.first}, this is Aidan, the CDL financial advisor assigned to the Trucker IUL request you just put in. Got it on my end. Quick one so I don't call you mid shift: you're in ${placeOf(c)}, right?`
      : c.talked
      ? `Hey ${c.first}, Aidan here, the CDL financial advisor on your Trucker IUL request. We talked a bit ago and I didn't want to let it slide. You're still in ${placeOf(c)}, right?`
      : `Hey ${c.first}, this is Aidan, the CDL financial advisor assigned to your Trucker IUL request. Tried calling a couple times, figured you were behind the wheel. You're still in ${placeOf(c)}, right?` },

  { day: 1, h: 17, mi: 30, label: 'D2 confirm driver type + OTR/regional', text: ({ first, group }) =>
    group === 'owner_op'
      ? `${first}, says here you're an owner operator, is that accurate? And are you OTR or running regional? Helps me know when you're actually parked so I'm not calling you mid shift.`
      : group === 'company'
        ? `${first}, says here you're a company driver, is that accurate? And are you OTR or running regional? Helps me know when you're actually parked so I'm not calling you mid shift.`
        : `${first}, quick one. Are you an owner operator or driving for a company? And OTR or regional? Helps me know when you're actually parked so I'm not calling you mid shift.` },

  { day: 3, h: 12, mi: 15, label: 'D3 who feels it first (beneficiary)', text: (c) => {
    const f = famOf(c);
    const named = famIsName(c) ? `you put ${f} down on the form` : '';
    if (goalKind(c.goal) === 'retirement') return `${c.first}, ${named ? named + ' and' : 'you put down'} retirement as the goal. Let me ask it straight: at 65 do you want to still be in the seat, or home with ${f}? That answer changes how I'd set this up.`;
    return `${c.first}, ${named ? named + '. ' : ''}Honest question, and I ask every driver this: if the truck stopped tomorrow, how long before ${f} would feel it? A month? Less?`; } },

  { day: 5, h: 10, mi: 0, label: 'D4 why I do this', text: ({ first }) =>
    `${first}, I'll be straight about why I do this. Drivers are the backbone of this country and yall get forgotten. Crazy schedules, always working, and nobody ever sits down with you to make sure the people at home are covered if you can't be. That's the whole reason I only work with CDL holders. Still want me to look at yours?` },

  { day: 7, h: 9, mi: 5, label: 'D5 buried or bad timing', text: ({ first }) =>
    `Morning ${first}. Did my texts get buried, or is this just bad timing right now? Either one's fine, just tell me which.` },

  { day: 9, h: 17, mi: 30, label: 'D7 health objection', text: ({ first }) =>
    `${first}, one thing that holds a lot of drivers back: blood pressure meds, sleep apnea, a few extra pounds. With the carriers I use for drivers, none of that is an automatic no. Is health part of what's had you on the fence?` },

  { day: 11, h: 10, mi: 0, label: 'D9 living benefits (works even if they already have a policy)', text: (c) => {
    const f = famOf(c);
    return c.group === 'company'
      ? `${c.first}, the part most company drivers never get told: the policy through work ends the day you leave or lose your med card, and almost none of them pay you anything while you're alive. The one I set drivers up with has living benefits, so if you get sick or hurt and can't drive, it pays you, not just ${f} after. Already got a policy? Worth checking if it does that. Want me to look?`
      : `${c.first}, the part most owner ops have never been told: the plan I set drivers up with has living benefits. If you get sick or hurt and can't drive, it pays you while you're alive, not just ${f} after. The truck note and the house note don't stop just because you did. Even if you've already got a policy, does yours do that?`; } },

  { day: 13, h: 9, mi: 30, label: 'D11 given up?', text: (c) =>
    `${c.first}, have you given up on this? No hard feelings if so. I just keep thinking you filled that form out for ${famOf(c)}, not for me, and I don't like leaving a driver hanging.` },

  { day: 15, h: 18, mi: 0, label: 'D14 the IUL: protection now, tax free income later', text: (c) =>
    `${c.first}, the IUL you asked about does two jobs. It protects ${famOf(c)} if something happens to you, and it builds cash you can pull as tax free income in retirement, with downside protection when the market drops. Most drivers have nothing doing that second job. I can show you how it works in 10 minutes. Want a spot this week?` },

  { day: 18, h: 12, mi: 15, label: 'D17 your schedule', text: ({ first }) =>
    `${first}, where you running this week? I work around driver schedules, not the other way around. Home time, 34 hour reset, sitting at a dock, I'll call whenever you say.` },

  { day: 21, h: 10, mi: 0, label: 'D20 price guess', text: ({ first }) =>
    `${first}, quick gut check. What do you figure something like this runs a month? Most drivers guess way high. Throw me a number and I'll tell you how close you are when we talk.` },

  { day: 24, h: 17, mi: 30, label: 'D24 after this run (the weight)', text: (c) => {
    const f = famOf(c);
    return `${c.first}, a lot of guys tell me "I'll get to it after this run." Then it's three runs later. If something happened on the next load, ${f} would have to figure out the truck note, the house, all of it, while grieving. That's not a sales line, it's the real question I'd ask you on the call. Would ${famIsName(c) ? f : 'they'} be alright?`; } },

  { day: 27, h: 9, mi: 30, label: 'D27 easy out: text the basics', text: ({ first }) =>
    `${first}, one of my last texts on this. Would it be easier if I just texted you the basics instead of calling? I can do that too, just say the word.` },

  { day: 30, h: 11, mi: 0, label: 'D30 close the file', text: (c) =>
    `${c.first}, I'm about to close your file so I quit bugging you. Before I do, was it bad timing, or did you get it handled somewhere else? One word is fine. Either way, drive safe out there, ${famOf(c)} needs you home.` },
];

// FRESH vendor leads (they just hit submit): D1 opener right away, then ONE text a day at most. Nudge the next morning,
// driver-type question the day after, the "reply YES" close on day 5, then the regular series (D3...D30) shifted two days later.
// Earlier version sent three texts on day 0 (opener, +20m, +4h); that was too many for one day, so the burst is gone.
// Any reply at any point hands the thread to the reply bot, so these only go out to leads who stayed silent.
export const FRESH_STEPS: Step[] = [
  STEPS[0],
  { day: 1, h: 10, mi: 15, label: 'F2 fresh nudge (next morning)', text: (c) =>
    `${c.first}, one more since you just put the request in: the fastest way to get you real numbers is a 10 minute call, no pressure and no paperwork. Are you parked right now or still rolling?` },
  { ...STEPS[1], day: 2 },
  { day: 4, h: 10, mi: 0, label: 'F3 fresh reply-YES close (day 5)', text: (c) =>
    `${c.first}, I'll keep it simple. Reply YES and I'll call you at this number in the next few minutes, or tell me a better time. If you'd rather I hold off for now, that's fine too, just say so.` },
  ...STEPS.slice(2).map((s) => ({ ...s, day: s.day + 2 })),
];
