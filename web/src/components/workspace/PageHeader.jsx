import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

/**
 * The top of every workspace page: title, an optional one-line description, and the page's
 * main actions on the right. `back` adds a small link above the title for detail pages.
 */
export default function PageHeader({ title, description, actions, back, children }) {
  return (
    <div className="mb-6">
      {back && (
        <Link to={back.to} className="mb-2 inline-flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft size={16} />{back.label}
        </Link>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0 flex-1">
          <h1 className="page-title">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
