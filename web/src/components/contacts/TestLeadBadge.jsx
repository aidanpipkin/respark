import { FlaskConical } from 'lucide-react';
import { isTestPhone } from '@/lib/phone';

/** Small "Test lead" marker for fictional 555-01xx contacts. Renders nothing for real leads. */
export default function TestLeadBadge({ phone, className = '' }) {
  if (!isTestPhone(phone)) return null;
  return <span title="Fictional test lead: never texted for real, never charged." className={`inline-flex shrink-0 items-center gap-1 rounded border border-dashed border-amber-400/70 bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 ${className}`}><FlaskConical size={11} />Test lead</span>;
}
