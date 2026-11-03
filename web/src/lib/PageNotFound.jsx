import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import ResparkLogo from '@/components/branding/ResparkLogo';

/** Shown for any address that isn't a page. Plain, with two ways out. */
export default function PageNotFound() {
  const navigate = useNavigate();
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm text-center">
        <Link to="/" aria-label="Respark home" className="mb-10 inline-block"><ResparkLogo className="!h-8 !w-28" /></Link>
        <p className="text-sm font-medium text-muted-foreground">Page not found</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">That page doesn't exist</h1>
        <p className="mt-2 text-sm text-muted-foreground">The link may be old or mistyped.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>Go back</Button>
          <Button asChild><Link to="/dashboard">Go to Home</Link></Button>
        </div>
      </div>
    </main>
  );
}
