// Loading states. A quiet splash while the app boots, and skeletons shaped like the page
// that is coming (never "Loading..." text), so nothing jumps when data arrives.

export function AppLoader({ label = '' }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-canvas" role="status" aria-live="polite">
      <span className="h-0.5 w-24 overflow-hidden rounded-full bg-border"><span className="block h-full w-1/3 rounded-full bg-primary lr-slide" /></span>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function Bone({ className = '' }) {
  return <span className={`block rounded-md bg-muted lr-shimmer ${className}`} />;
}

/** Placeholder shaped like a page: header, then a list. */
export function PageSkeleton({ panels = 2 }) {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="flex items-center justify-between"><Bone className="h-7 w-48" /><Bone className="h-9 w-28" /></div>
      {Array.from({ length: panels }).map((_, i) => (
        <div key={i} className="panel divide-y">
          {Array.from({ length: 4 }).map((__, j) => <div key={j} className="flex items-center gap-3 p-4"><Bone className="h-8 w-8 rounded-full" /><div className="flex-1 space-y-2"><Bone className="h-3.5 w-1/3" /><Bone className="h-3 w-2/3" /></div></div>)}
        </div>
      ))}
    </div>
  );
}

/** Placeholder for one section inside a page. */
export function PanelSkeleton({ rows = 3, className = '' }) {
  return (
    <section className={`panel divide-y ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="space-y-2 p-4"><Bone className="h-3.5 w-1/4" /><Bone className={`h-3 ${i % 2 ? 'w-3/5' : 'w-4/5'}`} /></div>)}
    </section>
  );
}
