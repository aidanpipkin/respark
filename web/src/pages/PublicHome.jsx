import { Link, Navigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { Button } from '@/components/ui/button';
import ChatDemo from '@/components/dashboard/ChatDemo';

// One lead's path through LeadRespark, as it actually happens.
const JOURNEY = [
  ['Monday', 'You upload 2,000 old leads', 'A CSV from any vendor or CRM. Notes, products and past calls all come along so the AI has something to work with.'],
  ['Monday, 11:40', 'Denise gets a text from you', '"Hi Denise, it\'s Mark with Carter Family Insurance. Last spring you asked about coverage for your grandkids. Still on your mind?"'],
  ['Wednesday, 6:12', 'She replies, and the AI keeps the conversation going', 'It answers her questions in your voice, handles the usual hesitation, and hands you anything about health, price or policy details.'],
  ['Wednesday, 6:15', 'A call lands on your calendar', 'She picks Friday at 10. She gets a confirmation, your buyer\'s guide and a reminder the evening before.'],
  ['Friday, 10:00', 'You call her from the same number', 'One tap rings your phone and connects you, from the number she already knows.'],
  ['After the call', 'Follow-up runs itself', 'No-show, "let me think", stuck at banking: each gets its own texts. New clients get a welcome, a premium reminder and check-ins.'],
];

const POINTS = [
  ['You stay in control', 'Approve every reply until you trust it. Take over any conversation in one tap, and get a text the moment someone needs you.'],
  ['Compliance built in', 'STOP is honored instantly. Texts only go out 9am to 8pm in the lead\'s time zone, with a daily cap per lead.'],
  ['Registration written for you', 'Your texting program, sample messages and opt-in page are written to carrier standards. You confirm your details and submit.'],
  ['Numbers that stay clean', 'Verified caller ID, spam-label monitoring and a health score on every number, so your texts and calls get through.'],
  ['An inbox built for volume', 'Hundreds of conversations sorted by who needs you, with bulk approve, quick replies and keyboard shortcuts.'],
  ['Every lead is different', 'Each text draws on what you know about that person: past notes, earlier calls, what they said last time.'],
];

const FAQ = [
  ['What kind of leads does it work with?', 'Life insurance leads who already asked about coverage: aged vendor leads, old CRM lists, and fresh leads sent in from your website or lead vendor. Playbooks are ready for final expense and for truck drivers interested in IUL.'],
  ['Will it say something I wouldn\'t?', 'It never quotes prices, never gives tax or legal advice, and never discusses health details by text. Those go to you. Start by approving every reply until you\'re comfortable.'],
  ['Do I need my own texting number or a CRM?', 'No. You get local numbers, and everything runs inside LeadRespark: leads, conversations, calendar, calls, pipeline and client follow-up.'],
  ['What about consent and the TCPA?', 'You only upload people who agreed to hear from you, and you confirm that when you upload. LeadRespark handles opt-outs, quiet hours and message limits. Talk to your own compliance advisor about your lead sources.'],
  ['What does it cost?', '$100 a month for the platform. Texts are 3¢ each from a prepaid balance you control. No contract.'],
];

export default function PublicHome() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return (
    <main>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-10 sm:px-6 md:grid-cols-[1.1fr_1fr] md:pb-24 md:pt-16">
        <div>
          <h1 className="max-w-xl text-[40px] font-semibold leading-[1.05] tracking-[-0.025em] sm:text-[56px]">Your old leads, booking calls again.</h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">LeadRespark texts the life insurance leads you already paid for, in your name. It keeps each conversation going, books calls on your calendar, and tells you when someone needs you.</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg"><Link to="/register">Start now</Link></Button>
            <Button asChild size="lg" variant="outline"><a href="#demo">Text the AI yourself</a></Button>
          </div>
          <p className="mt-5 text-sm text-muted-foreground">$100 a month. No contract. Setup takes about 15 minutes.</p>
        </div>
        <div id="demo" className="scroll-mt-20">
          <div className="mx-auto max-w-sm overflow-hidden rounded-[28px] border bg-card shadow-[0_30px_60px_-30px_hsl(165_30%_8%/0.35)]">
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">JR</span>
              <div className="min-w-0"><p className="text-sm font-semibold leading-tight">Jordan, Summit Life Group</p><p className="text-xs text-muted-foreground">You're Marcus, a trucker who asked about coverage in February.</p></div>
            </div>
            <ChatDemo endpoint="publicDemo" agent="Jordan" agency="Summit Life Group" className="h-[420px]" />
          </div>
          <p className="mt-3 text-center text-sm text-muted-foreground">This is the real AI. Push back, ask questions, or say STOP.</p>
        </div>
      </section>

      <section className="border-t bg-canvas">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-6 md:py-20">
          <h2 className="max-w-xl text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">From a forgotten list to a call on Friday.</h2>
          <ol className="mt-10 max-w-3xl">
            {JOURNEY.map(([when, title, body], i) => (
              <li key={title} className="relative grid gap-1 pb-8 pl-8 sm:grid-cols-[150px_1fr] sm:gap-6 sm:pl-0">
                <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-primary sm:left-[150px] sm:-ml-[29px]" />
                {i < JOURNEY.length - 1 && <span className="absolute bottom-0 left-[4px] top-5 w-px bg-border sm:left-[150px] sm:-ml-[25px]" />}
                <p className="text-sm text-muted-foreground sm:pt-0.5 sm:text-right">{when}</p>
                <div><h3 className="font-semibold">{title}</h3><p className="mt-1 leading-relaxed text-muted-foreground">{body}</p></div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 md:py-20">
        <h2 className="max-w-2xl text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">Built for agents who live on their phone.</h2>
        <dl className="mt-10 grid gap-x-12 sm:grid-cols-2">
          {POINTS.map(([title, body]) => (
            <div key={title} className="border-t py-5">
              <dt className="font-semibold">{title}</dt>
              <dd className="mt-1 leading-relaxed text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-6 md:pb-20">
        <div className="grid gap-10 rounded-xl border p-6 sm:p-10 md:grid-cols-[1fr_1.2fr] md:items-center">
          <div>
            <h2 className="text-lg font-semibold">Pricing</h2>
            <p className="mt-3 text-5xl font-semibold tracking-[-0.02em] tabular-nums">$100<span className="text-lg font-normal text-muted-foreground"> a month</span></p>
            <p className="mt-3 leading-relaxed text-muted-foreground">Plus texts at 3¢ each from a prepaid balance with auto-reload you control. One closed policy covers years of LeadRespark.</p>
            <Button asChild size="lg" className="mt-6"><Link to="/register">Start now</Link></Button>
          </div>
          <ul className="space-y-3">
            {['AI texting in your name, with replies you approve', 'Local numbers with spam protection', 'Calls from the same number that texts them', 'Calendar booking, confirmations and reminders', 'Pipeline, outcomes and follow-up after every call', 'Client welcome, premium reminders and check-ins', 'Carrier registration written for you'].map(t => (
              <li key={t} className="flex gap-3"><Check size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />{t}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t bg-canvas">
        <div className="mx-auto max-w-3xl px-5 py-16 sm:px-6 md:py-20">
          <h2 className="text-3xl font-semibold tracking-[-0.02em]">Questions agents ask</h2>
          <div className="mt-8 divide-y border-y">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">{q}<span className="text-xl leading-none text-muted-foreground transition-transform group-open:rotate-45" aria-hidden="true">+</span></summary>
                <p className="mt-3 leading-relaxed text-muted-foreground">{a}</p>
              </details>
            ))}
          </div>
          <div className="mt-14">
            <h2 className="text-2xl font-semibold tracking-[-0.02em]">Those leads aren't dead. They're waiting for a text.</h2>
            <Button asChild size="lg" className="mt-5"><Link to="/register">Start now</Link></Button>
          </div>
        </div>
      </section>
    </main>
  );
}
