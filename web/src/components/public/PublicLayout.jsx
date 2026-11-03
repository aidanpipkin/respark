import { useEffect } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import PublicFooter from '@/components/public/PublicFooter';
import ResparkLogo from '@/components/branding/ResparkLogo';

export default function PublicLayout() {
  useEffect(() => {
    const before = document.title;
    document.title = 'LeadRespark: your old insurance leads, booking calls again';
    return () => { document.title = before; };
  }, []);
  return <div className="public-site flex min-h-dvh flex-col bg-background font-body text-foreground">
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <nav aria-label="Main navigation" className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-5 sm:px-6">
        <Link to="/" aria-label="LeadRespark home"><ResparkLogo className="!h-8 !w-28 object-left" /></Link>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost"><Link to="/login">Sign in</Link></Button>
          <Button asChild><Link to="/register">Start now</Link></Button>
        </div>
      </nav>
    </header>
    <div className="flex-1"><Outlet/></div>
    <PublicFooter/>
  </div>;
}