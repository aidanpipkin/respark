import { Suspense } from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppLoader, PageSkeleton } from '@/components/system/Loaders';
import ErrorBoundary from '@/components/system/ErrorBoundary';
import { ReferralClaimer } from '@/components/dashboard/ReferralCard';
import AccountAlerts from '@/components/system/AccountAlerts';
import HelpDialog from '@/components/system/HelpButton';
import AppNav from '@/components/workspace/AppNav';
import useBranding from '@/components/workspace/useBranding';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';

// Pages that manage their own full-height layout (no page padding, no max width).
const FULL_BLEED = ['/inbox'];

export default function WorkspaceLayout() {
  const location = useLocation();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['workspace'], queryFn: () => call('workspace'), staleTime: 300000 });
  useBranding(data?.settings);

  if (data?.needs_welcome && location.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  if (isLoading) return <AppLoader />;
  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
        <div className="panel max-w-sm space-y-3 p-6 text-center">
          <h1 className="text-base font-semibold">Your workspace didn't load</h1>
          <p className="text-sm text-muted-foreground">Check your connection and try again. Your campaigns keep running in the background.</p>
          <p className="text-xs text-destructive">{error.message}</p>
          <Button onClick={() => refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  // First-run setup is its own focused screen: no workspace navigation until the workspace exists.
  if (location.pathname === '/welcome') {
    return (<><HelpDialog /><ErrorBoundary resetKey={location.pathname}><Suspense fallback={<AppLoader />}><Outlet context={data} /></Suspense></ErrorBoundary></>);
  }
  const full = FULL_BLEED.some(p => location.pathname.startsWith(p));
  return (
    <div className="min-h-dvh bg-background">
      <ReferralClaimer />
      <HelpDialog />
      <AppNav user={data.user} settings={data.settings} />
      <div className="lg:pl-[232px]">
        <main className={full ? 'pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0' : 'mx-auto w-full max-w-[1280px] px-4 pb-[calc(88px+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:px-10 lg:pb-12 lg:pt-8'}>
          {data.awaiting_setup && !location.pathname.startsWith('/setup/') ? (
            <div className="panel mx-auto mt-10 max-w-md p-6 text-center">
              <h1 className="text-base font-semibold">Your account is being prepared</h1>
              <p className="mt-1 text-sm text-muted-foreground">We'll email you as soon as your workspace is ready.</p>
            </div>
          ) : (
            <>
              {!full && <AccountAlerts email={data.user?.email} />}
              <ErrorBoundary resetKey={location.pathname}>
                <Suspense fallback={full ? null : <PageSkeleton />}>
                  <Outlet context={data} />
                </Suspense>
              </ErrorBoundary>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
