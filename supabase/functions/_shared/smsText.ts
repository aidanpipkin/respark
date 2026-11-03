// Text hygiene for SMS. One curly quote or dash switches a whole text to Unicode, which cuts a
// segment from 160 to 70 characters (up to 3x the cost and the carrier quota). It also checks for
// the phrases that make a text read as automated, and for near-repeats of earlier texts.

// GSM 03.38 basic set plus the common extension characters.
const GSM = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]|€]*$/;

/** Swaps typographic characters for plain ones and tidies whitespace. */
export function smsClean(text: string) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s*[–—―]\s*/g, ', ')
    .replace(/…/g, '...')
    .replace(/[    ]/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.?])/g, '$1')
    .trim();
}

/** True if the text still has characters outside the standard SMS alphabet. */
export function nonGsm(text: string) { return !GSM.test(String(text || '')); }

const TELLS = [
  'great question', 'absolutely', 'i understand your concern', 'i hope this finds you', 'i hope this message', 'hope you are doing well',
  "hope you're doing well", 'just circling back', 'touching base', 'per my last', 'feel free to', "don't hesitate", 'at your earliest convenience',
  'i wanted to reach out', 'as an ai', 'certainly', 'rest assured', 'kind regards', 'best regards',
];
/** The first phrase that makes a text read as automated or corporate, if any. */
export function aiTells(text: string) {
  const t = String(text || '').toLowerCase();
  if (/;/.test(t)) return 'semicolon';
  return TELLS.find(p => t.includes(p)) || '';
}

const words = (t: string) => String(t || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
function shingles(t: string) { const w = words(t); const out = new Set<string>(); for (let i = 0; i < w.length - 1; i++) out.add(`${w[i]} ${w[i + 1]}`); return out; }

/** True if the text reuses most of an earlier text's wording (word-pair overlap). */
export function tooSimilar(text: string, previous: string[] = [], threshold = 0.45) {
  const a = shingles(text);
  if (a.size < 4) return false;
  return previous.some(p => {
    const b = shingles(p); if (b.size < 4) return false;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    return inter / Math.min(a.size, b.size) >= threshold;
  });
}
