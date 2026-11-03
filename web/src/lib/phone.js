/** +15551234567 → (555) 123-4567. Anything else is returned as given. */
export const prettyPhone = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

/** Fictional test numbers (the reserved 555-01xx range, e.g. +1 501 555 0142). Mirrors shared/rehearsal.ts isTestPhone. */
export const isTestPhone = p => /^\+1\d{3}55501\d{2}$/.test(String(p || ''));
