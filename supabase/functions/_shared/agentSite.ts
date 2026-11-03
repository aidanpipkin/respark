// Each agent gets a hosted, carrier-compliant mini-site at /a/{slug}:
// home, request-info form with optional consent checkbox, privacy policy and SMS terms.
import { businessName, consentText } from './publicSite.ts';

function slugify(v: string) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agent';
}

/** Gives the agent a unique public slug if they don't have one. Returns the slug. */
export async function ensurePublicSlug(E: any, s: any) {
  if (s.public_slug && /^[a-z0-9-]{2,60}$/.test(s.public_slug)) return s.public_slug as string;
  const base = slugify(s.brand_name || [s.first_name, s.last_name].filter(Boolean).join(' ') || String(s.agent_email || '').split('@')[0]);
  for (let i = 0; i < 20; i++) {
    const candidate = i ? `${base}-${i + 1}` : base;
    const taken = await E.AgentSettings.filter({ public_slug: candidate }, { limit: 1 });
    if (!taken.items[0] || taken.items[0].id === s.id) { await E.AgentSettings.update(s.id, { public_slug: candidate }); return candidate; }
  }
  const fallback = `${base}-${crypto.randomUUID().slice(0, 6)}`;
  await E.AgentSettings.update(s.id, { public_slug: fallback });
  return fallback;
}

export function appOrigin(req: Request) {
  const header = req.headers.get('x-base44-app-url');
  if (header && /^https:\/\//.test(header)) return new URL(header).origin;
  return (Deno.env.get('APP_URL') || 'https://respark-pipkingroup.com').replace(/\/$/, '');
}

export function siteLinks(origin: string, slug: string) {
  const root = `${origin}/a/${slug}`;
  return { url: root, get_info_url: `${root}/get-info`, privacy_url: `${root}/privacy`, terms_url: `${root}/sms-terms` };
}

/** Opt-in description for A2P that matches the hosted form exactly. */
export function hostedOptInFlow(s: any, links: { get_info_url: string; privacy_url: string; terms_url: string }) {
  return `Contacts opt in on our website form at ${links.get_info_url}. They enter their name, phone number, email, state and coverage interest, and may check a separate, optional checkbox that is unchecked by default and reads: "${consentText(s)}" Submitting the form does not require consent. We only text people who gave this consent naming ${businessName(s)}, or who previously requested life insurance information from ${businessName(s)} and gave documented consent. Privacy policy: ${links.privacy_url}. SMS terms: ${links.terms_url}.`;
}
