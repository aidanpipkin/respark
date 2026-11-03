import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Home, MessageSquare, Users, CalendarDays, KanbanSquare, BadgeCheck, Megaphone, Phone, Wallet,
  Settings, Shield, LogOut, LifeBuoy, MoreHorizontal, ChevronRight,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import ResparkLogo from '@/components/branding/ResparkLogo';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { openHelp } from '@/components/system/HelpButton';

const WORK = [
  { to: '/dashboard', label: 'Home', icon: Home },
  { to: '/inbox', label: 'Inbox', icon: MessageSquare, count: true },
  { to: '/contacts', label: 'Leads', icon: Users },
  { to: '/appointments', label: 'Calendar', icon: CalendarDays },
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/clients', label: 'Clients', icon: BadgeCheck },
];
const MANAGE = [
  { to: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { to: '/numbers', label: 'Phone numbers', icon: Phone },
  { to: '/credits', label: 'Billing & credits', icon: Wallet },
  { to: '/profile', label: 'Settings', icon: Settings },
];
const TABS = ['/dashboard', '/inbox', '/contacts', '/appointments'];

function useInboxCount() {
  const { data } = useQuery({ queryKey: ['inbox-counts'], queryFn: () => call('inbox', { action: 'counts' }), refetchInterval: 30000, staleTime: 15000, retry: false });
  return data ? (data.counts.needs_you || 0) + (data.counts.unread || 0) : 0;
}

const initials = name => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'A';
const signOut = () => base44.auth.logout('/login');

function Count({ n, className = '' }) {
  if (!n) return null;
  return <span className={`ml-auto min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold leading-5 text-primary-foreground tabular-nums ${className}`}>{n > 99 ? '99+' : n}</span>;
}

function usePendingApprovals(admin) {
  const { data } = useQuery({ queryKey: ['pending-approvals'], queryFn: () => call('adminAgents', { action: 'pending_count' }), enabled: !!admin, refetchInterval: 60000, staleTime: 30000, retry: false });
  return data?.pending || 0;
}

function SideLink({ item, count }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      className={({ isActive }) => `flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${isActive ? 'bg-sidebar-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'}`}
    >
      <Icon size={17} strokeWidth={1.9} />
      <span className="truncate">{item.label}</span>
      {item.count && <Count n={count} />}
    </NavLink>
  );
}

/** "Finish setup" shortcut while an agent is still getting live. Same checklist as Home. */
function SetupLink({ live }) {
  const { data } = useQuery({ queryKey: ['launch'], queryFn: () => call('launch', {}), staleTime: 30000, enabled: !live });
  if (live || !data?.items?.length) return null;
  const done = data.items.filter(i => i.done).length, total = data.items.length;
  if (done >= total) return null;
  const next = data.items.find(i => !i.done);
  return (
    <Link to={next?.href || '/dashboard'} className="mx-3 mb-3 block rounded-lg border bg-card p-3 transition-colors hover:border-primary/40 [@media(max-height:700px)]:hidden">
      <div className="flex items-center justify-between text-sm font-medium">Finish setup<span className="text-xs font-normal text-muted-foreground tabular-nums">{done} of {total}</span></div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / total) * 100}%` }} /></div>
      {next && <p className="mt-2 flex items-center gap-1 truncate text-xs text-muted-foreground">Next: {next.label}<ChevronRight size={12} className="shrink-0" /></p>}
    </Link>
  );
}

function Sidebar({ user, settings, count }) {
  const admin = user?.role === 'admin';
  const pending = usePendingApprovals(admin);
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r bg-canvas lg:flex" data-print-hide>
      <Link to="/dashboard" className="flex h-16 items-center px-4" aria-label="Home"><ResparkLogo className="!h-8 !w-28 object-left" /></Link>
      <nav className="no-scrollbar flex-1 space-y-6 overflow-y-auto px-3 pb-4 pt-1" aria-label="Main">
        <div className="space-y-0.5">{WORK.map(i => <SideLink key={i.to} item={i} count={count} />)}</div>
        <div className="space-y-0.5">
          <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground/80">Manage</p>
          {MANAGE.map(i => <SideLink key={i.to} item={i} />)}
          {admin && <SideLink item={{ to: pending ? '/admin' : '/admin/command', label: 'Admin', icon: Shield, count: true }} count={pending} />}
        </div>
      </nav>
      <SetupLink live={settings?.status === 'live'} />
      <div className="border-t p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-sidebar-accent/60">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(settings?.display_name || user?.full_name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{settings?.display_name || user?.full_name || 'Your account'}</span>
                <span className="block truncate text-xs text-muted-foreground">{settings?.mode === 'autopilot' ? 'AI replies automatically' : 'You approve replies'}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-[208px]">
            <DropdownMenuItem asChild><Link to="/profile"><Settings />Settings</Link></DropdownMenuItem>
            <DropdownMenuItem onSelect={openHelp}><LifeBuoy />Get help</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}><LogOut />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

function MobileBars({ user, settings, count }) {
  const pending = usePendingApprovals(user?.role === 'admin');
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  useEffect(() => { setMore(false); }, [pathname]);
  const admin = user?.role === 'admin';
  const tabs = WORK.filter(i => TABS.includes(i.to));
  const rest = [...WORK.filter(i => !TABS.includes(i.to)), ...MANAGE, ...(admin ? [{ to: pending ? '/admin' : '/admin/command', label: pending ? `Admin (${pending} waiting)` : 'Admin', icon: Shield }] : [])];
  const moreActive = rest.some(i => pathname.startsWith(i.to));
  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center border-b bg-background/95 px-4 backdrop-blur lg:hidden" data-print-hide>
        <Link to="/dashboard" aria-label="Home"><ResparkLogo className="!h-7 !w-24 object-left" /></Link>
      </header>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Main" data-print-hide>
        {tabs.map(i => {
          const Icon = i.icon;
          return (
            <NavLink key={i.to} to={i.to} className={({ isActive }) => `relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${isActive ? 'font-medium text-primary' : 'text-muted-foreground'}`}>
              <Icon size={20} strokeWidth={1.9} />{i.label}
              {i.count && count > 0 && <span className="absolute left-1/2 top-1.5 ml-2 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground">{count > 99 ? '99+' : count}</span>}
            </NavLink>
          );
        })}
        <button type="button" onClick={() => setMore(true)} className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${moreActive ? 'font-medium text-primary' : 'text-muted-foreground'}`}>
          <MoreHorizontal size={20} />More
        </button>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)]">
          <SheetHeader className="sr-only"><SheetTitle>More</SheetTitle><SheetDescription>Everything else in your workspace</SheetDescription></SheetHeader>
          <div className="flex items-center gap-3 border-b px-5 py-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(settings?.display_name || user?.full_name)}</span>
            <div className="min-w-0"><p className="truncate text-sm font-medium">{settings?.display_name || user?.full_name}</p><p className="truncate text-xs text-muted-foreground">{user?.email}</p></div>
          </div>
          <div className="grid grid-cols-3 gap-1 p-3">
            {rest.map(i => {
              const Icon = i.icon;
              return <Link key={i.to} to={i.to} className={`flex flex-col items-center gap-1.5 rounded-lg px-2 py-3 text-center text-xs ${pathname.startsWith(i.to) ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground active:bg-muted'}`}><Icon size={20} strokeWidth={1.9} />{i.label}</Link>;
            })}
          </div>
          <div className="grid grid-cols-2 gap-2 border-t p-3">
            <button type="button" onClick={() => { setMore(false); openHelp(); }} className="flex h-11 items-center justify-center gap-2 rounded-md border text-sm"><LifeBuoy size={16} />Get help</button>
            <button type="button" onClick={signOut} className="flex h-11 items-center justify-center gap-2 rounded-md border text-sm"><LogOut size={16} />Sign out</button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default function AppNav({ user, settings }) {
  const count = useInboxCount();
  return <><Sidebar user={user} settings={settings} count={count} /><MobileBars user={user} settings={settings} count={count} /></>;
}
