import { Link } from 'react-router-dom';
import ResparkLogo from '@/components/branding/ResparkLogo';

export default function PublicFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-6xl flex-col justify-between gap-6 px-5 py-10 sm:flex-row sm:items-center sm:px-6">
        <div>
          <Link to="/" aria-label="LeadRespark home"><ResparkLogo className="!h-7 !w-24 object-left" /></Link>
          <p className="mt-2 text-sm text-muted-foreground">AI texting and follow-up for life insurance agents.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <Link className="hover:text-foreground" to="/login">Sign in</Link>
          <Link className="hover:text-foreground" to="/register">Start now</Link>
          <Link className="hover:text-foreground" to="/privacy">Privacy</Link>
          <Link className="hover:text-foreground" to="/terms">Terms</Link>
        </nav>
      </div>
      <p className="mx-auto max-w-6xl px-5 pb-8 text-xs text-muted-foreground sm:px-6">© {new Date().getFullYear()} LeadRespark</p>
    </footer>
  );
}
