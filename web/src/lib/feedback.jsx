// Feedback for every action: a short, satisfying confirmation when something worked, a plain
// explanation when it didn't, and (where it matters) a button to the next thing to do.
//
//   notify.ok('Hours saved', 'The AI now offers these times.')
//   notify.ok('Number added', '', { label: 'Next: Register for texting', to: '/setup/texting-registration' })
//   notify.err(error)
//
//   const { run, busy } = useAction();
//   <Button loading={busy === 'save'} onClick={() => run('save', () => call(...), { ok: 'Saved', invalidate: [['key']] })}>Save</Button>
import { useCallback, useState } from 'react';
import { toast, Toaster as Sonner } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, AlertCircle, Info } from 'lucide-react';

// Navigation from inside a toast (toasts render outside the router's components).
let navigateRef = null;
export function FeedbackRouterBridge() { navigateRef = useNavigate(); return null; }
const go = to => (navigateRef ? navigateRef(to) : (window.location.href = to));

function message(e) {
  const m = typeof e === 'string' ? e : e?.message || 'Something went wrong. Try again.';
  return /failed to fetch|network/i.test(m) ? 'Connection dropped. Check your internet and try again.' : m;
}

const ICON_OK = <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white lr-pop"><Check size={12} strokeWidth={3} /></span>;
const ICON_ERR = <AlertCircle size={18} className="text-destructive" />;
const ICON_INFO = <Info size={18} className="text-muted-foreground" />;

function withAction(next) {
  if (!next) return {};
  return { action: { label: next.label, onClick: () => (next.to ? go(next.to) : next.onClick?.()) }, duration: 7000 };
}

// When the last success toast fired, so automatic follow-ups (like setup progress) don't stack on top of it.
export let lastOkAt = 0;

export const notify = {
  ok: (title, description = '', next = null) => (lastOkAt = Date.now(), toast(title, { description: description || undefined, icon: ICON_OK, ...withAction(next) })),
  err: (e, title = '') => toast(title || message(e), { description: title ? message(e) : undefined, icon: ICON_ERR, duration: 6000 }),
  info: (title, description = '', next = null) => toast(title, { description: description || undefined, icon: ICON_INFO, ...withAction(next) }),
};

/**
 * Runs an action with a busy state, a success toast and an error toast.
 * `key` lets one component track several buttons. Returns the action's result, or undefined on error.
 */
export function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  const run = useCallback(async (key, fn, opts = {}) => {
    setBusy(key);
    try {
      const result = await fn();
      if (opts.invalidate?.length) await Promise.all(opts.invalidate.map(k => qc.invalidateQueries({ queryKey: k })));
      const ok = typeof opts.ok === 'function' ? opts.ok(result) : opts.ok;
      if (ok) notify.ok(ok, typeof opts.detail === 'function' ? opts.detail(result) : opts.detail || '', opts.next || null);
      return result;
    } catch (e) {
      notify.err(e, opts.errTitle || '');
      if (opts.throw) throw e;
      return undefined;
    } finally { setBusy(''); }
  }, [qc]);
  return { run, busy };
}

/** App-wide toaster: bottom right on desktop, above the tab bar on phones. */
export function FeedbackToaster() {
  return (
    <Sonner
      position="bottom-right"
      offset={24}
      mobileOffset={{ bottom: 'calc(72px + env(safe-area-inset-bottom))', left: 12, right: 12 }}
      gap={8}
      visibleToasts={3}
      duration={3500}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: 'pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-card p-3.5 text-sm text-foreground shadow-lg sm:w-[360px]',
          title: 'font-medium leading-5',
          description: 'mt-0.5 text-[13px] leading-5 text-muted-foreground',
          icon: 'mt-px shrink-0',
          actionButton: 'ml-auto shrink-0 self-center rounded-md bg-primary px-2.5 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90',
          closeButton: 'hidden',
        },
      }}
    />
  );
}
