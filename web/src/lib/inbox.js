// Small helpers shared by the inbox screens.

export function shortAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const ms = now - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// How urgent a waiting reply is: calm under 15 minutes, warm under an hour, hot after.
export function waitTone(ts, now = Date.now()) {
  const m = (now - new Date(ts).getTime()) / 60000;
  if (m < 15) return 'calm';
  if (m < 60) return 'warm';
  return 'hot';
}

const GSM = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsSegments(text) {
  const t = String(text || '');
  if (!t) return 0;
  if (GSM.test(t)) return t.length <= 160 ? 1 : Math.ceil(t.length / 153);
  const n = [...t].length;
  return n <= 70 ? 1 : Math.ceil(n / 67);
}

export function fillQuickReply(text, { first_name, my_name }) {
  return String(text || '')
    .replace(/\{first_name\}/g, first_name || 'there')
    .replace(/\{my_name\}/g, my_name || '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function isTyping(e) {
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export const isDesktop = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

export const INBOX_TABS = [
  { key: 'needs_human', label: 'Needs you', count: 'needs_you', hot: true },
  { key: 'drafts', label: 'To approve', count: 'drafts', hot: true },
  { key: 'unanswered', label: 'Unanswered', count: 'unanswered', hot: true },
  { key: 'unread', label: 'New', count: 'unread', hot: true },
  { key: 'replied', label: 'Conversations', count: 'replied' },
  { key: 'booked', label: 'Booked', count: 'booked' },
  { key: 'all', label: 'All texts' },
];

export function tabQuery(filter) {
  if (filter === 'drafts') return { has_pending_draft: true };
  if (filter === 'unread') return { unread: true };
  if (filter === 'replied') return { replied_at: { $exists: true, $nin: ['', null] } };
  if (filter === 'unanswered') return { last_direction: 'inbound', status_chip: { $nin: ['opted_out', 'not_interested'] } };
  // Contacts synced from the CRM with no texts yet are not conversations.
  if (filter === 'all') return { last_message: { $exists: true, $nin: ['', null] } };
  return { status_chip: filter };
}
