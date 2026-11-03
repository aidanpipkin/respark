import { Link } from 'react-router-dom';
import ResparkLogo from '@/components/branding/ResparkLogo';

// What the product does, shown the way agents will actually see it: an old lead coming back.
const THREAD = [
  ['out', "Hi Denise, it's Mark with Carter Family Insurance. Last spring you asked about coverage for your grandkids' future. Still something you're thinking about?"],
  ['in', 'Oh wow, yes. Things got busy. Is it too late?'],
  ['out', 'Not at all. I have Thursday at 2 or Friday at 10 for a quick call. Which works better?'],
  ['in', 'Friday at 10'],
];

function Showcase() {
  return (
    <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-navy p-10 text-navy-foreground lg:flex">
      <ResparkLogo light className="!h-9 !w-32 object-left" />
      <div className="mx-auto w-full max-w-sm space-y-2.5">
        {THREAD.map(([dir, text], i) => (
          <p key={i} className={`w-fit max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${dir === 'out' ? 'ml-auto rounded-br-md bg-white text-foreground' : 'rounded-bl-md bg-white/12 text-white'}`}>{text}</p>
        ))}
        <p className="pt-3 text-center text-xs text-white/60">Booked for Friday, 10:00 AM. Added to your calendar.</p>
      </div>
      <p className="max-w-sm text-sm text-white/70">LeadRespark texts the leads you already paid for, answers them, and books the calls. You take it from there.</p>
    </div>
  );
}

export default function AuthLayout({ title, subtitle, footer, children }) {
  return (
    <div className="flex min-h-dvh bg-background">
      <div className="flex w-full flex-col px-5 py-8 sm:px-10 lg:w-[480px] lg:shrink-0 lg:px-14">
        <Link to="/" aria-label="LeadRespark home" className="lg:hidden"><ResparkLogo className="!h-8 !w-28 object-left" /></Link>
        <div className="my-auto w-full max-w-sm py-10 lg:mx-auto">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <p className="mt-6 text-sm text-muted-foreground">{footer}</p>}
        </div>
        <p className="text-xs text-muted-foreground"><Link to="/terms" className="hover:text-foreground">Terms</Link><span className="mx-2">/</span><Link to="/privacy" className="hover:text-foreground">Privacy</Link></p>
      </div>
      <Showcase />
    </div>
  );
}
