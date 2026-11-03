import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import ResparkLogo from '@/components/branding/ResparkLogo';

/** Signed in, but this email has no LeadRespark workspace. */
export default function UserNotRegisteredError() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm text-center">
        <ResparkLogo className="mx-auto mb-10 !h-8 !w-28" />
        <h1 className="text-2xl font-semibold tracking-tight">No workspace for this email</h1>
        <p className="mt-2 text-sm text-muted-foreground">You're signed in, but this email isn't set up on LeadRespark. Sign in with the email you used to join, or ask whoever invited you to add this one.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={() => base44.auth.logout('/login')}>Sign in with another email</Button>
        </div>
      </div>
    </main>
  );
}
