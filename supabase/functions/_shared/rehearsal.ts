// Dress rehearsal: a built-in test agent that runs the REAL engine end to end (scheduling,
// safety checks, pipeline, inbox summaries, credits path) with every outside call switched off.
// Nothing is texted, nothing is charged, no GHL contact is touched. Used to prove scale.

export const REHEARSAL_EMAIL = 'rehearsal@leadrespark.internal';
export const REHEARSAL_LOCATION = 'rehearsal-location';

export function isRehearsal(x: any) {
  const email = typeof x === 'string' ? x : x?.agent_email;
  return String(email || '').toLowerCase() === REHEARSAL_EMAIL;
}

/**
 * Fictional test numbers: the reserved 555-01xx range (+1 NXX 555 01xx), e.g. +1 501 555 0142.
 * Leads with these numbers run through the real engine (sequence, AI replies, inbox) but are never
 * texted through Twilio or GHL, never charged, and bypass the number / carrier-registration gates.
 */
export const TEST_PHONE_RE = /^\+1\d{3}55501\d{2}$/;
export function isTestPhone(phone: any) { return TEST_PHONE_RE.test(String(phone || '')); }
export function isTestLead(lead: any) { return isTestPhone(lead?.phone); }
/** Contact ids that only exist in LeadRespark (never in GHL): unknown inbound numbers and test leads. */
export function localContactId(id: any) { const v = String(id || ''); return v.startsWith('tw:') || v.startsWith('test:'); }

/** A fake carrier message id, shaped so nothing mistakes it for a real Twilio SID. */
export function fakeMessageId() { return `DRY${crypto.randomUUID().replace(/-/g, '').slice(0, 29)}`; }

/** Whether the rehearsal should also exercise the AI writer (costs real AI calls). */
export async function rehearsalUsesAI(E: any) {
  try { return (await E.EngineCursor.filter({ key: 'rehearsal:ai' }, { limit: 1 })).items[0]?.cursor === 'on'; } catch { return false; }
}
