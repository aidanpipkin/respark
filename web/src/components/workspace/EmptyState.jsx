import { Inbox } from 'lucide-react';

/** What to show when a list is empty: what's missing and what to do about it. */
export default function EmptyState({ icon: Icon = Inbox, title, description, children, compact = false }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 text-center ${compact ? 'py-8' : 'py-14'}`}>
      <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}
