const banned = ['tax-free','guaranteed',"can't lose money",'zero is your hero','be your own bank','beats a 401(k)','beats the market','invest','investment','you qualify',"you're approved",'premium','monthly cost','rate','Medicare'];
export const conditions = /\b(diabetes|cancer|asthma|COPD|HIV|AIDS|stroke|heart attack|hypertension|epilepsy|bipolar|depression|arthritis|alzheimer'?s|parkinson'?s|multiple sclerosis|kidney disease|sleep apnea)\b/i;
export function guardrailCheck(text) {
  const flags = []; const normalized = String(text || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/[‐‑–—]/g, '-');
  if (normalized.length > 300) flags.push('Over 300 characters');
  if (/[$€£]\s*\d|\d[\d,.]*\s*(%|percent|dollars|USD)\b|\d\s*%/i.test(normalized)) flags.push('Dollar amount or percentage');
  for (const term of banned) { const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if (new RegExp(`\\b${escaped}(?:s)?\\b`, 'i').test(normalized)) flags.push(`Restricted wording: ${term}`); }
  if (conditions.test(normalized)) flags.push('Named medical condition');
  return { passed: flags.length === 0, flags, character_count: normalized.length };
}
// Opt-outs. Carrier keywords count when they are the whole message (or lead it, like "STOP please");
// plain-language requests count anywhere ("please stop texting me", "take me off your list").
// The FCC requires honoring revocation by any reasonable means, so this errs toward stopping.
const KEYWORDS = ['stop', 'stopall', 'stop all', 'end', 'cancel', 'quit', 'unsubscribe', 'revoke', 'optout', 'opt out', 'opt-out'];
const PHRASES = ['stop texting', 'stop messaging', 'stop contacting', 'stop sending', 'quit texting', "don't text", 'do not text', 'dont text', "don't contact", 'do not contact', 'remove me', 'remove my number', 'take me off', 'leave me alone', 'unsubscribe', 'opt me out', 'opt out', 'wrong number', 'no more texts', 'no more messages', 'lose my number', 'delete my number', 'not the right person', 'never contact'];
export function stopRequested(text, extra = []) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const bare = t.replace(/[^a-z' -]/g, '').trim();
  if (KEYWORDS.includes(bare)) return true;
  if (/^stop\b/.test(bare)) return true;
  const esc = (w) => w.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...PHRASES, ...extra].some(w => { const e = esc(w); return e && new RegExp(`(?:^|\\b)${e}(?:$|\\b)`, 'i').test(t); });
}
export function sensitiveInput(text) { return conditions.test(text) || /\b(complaint|lawyer|regulator|quote|illustration|medicare)\b/i.test(text); }
export const replySchema = { type: 'object', properties: { reply_text: { type: 'string' }, intent: { type: 'string' }, sentiment: { type: 'string' }, stage: { type: 'integer', minimum: 1, maximum: 6 }, action: { type: 'string', enum: ['none','get_free_slots','book_appointment','flag_for_human','stop'] }, chosen_slot_iso: { type: 'string' }, needs_human_reason: { type: 'string' }, summary: { type: 'string' } }, required: ['reply_text','intent','sentiment','stage','action','chosen_slot_iso','needs_human_reason','summary'] };