import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, CheckCheck, MessageSquare } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/workspace/PageHeader';
import EmptyState from '@/components/workspace/EmptyState';
import { Bone } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import ThinCalendarBanner from '@/components/appointments/ThinCalendarBanner';
import { stageColors } from '@/lib/stages';
import { shortAgo } from '@/lib/inbox';
import useDashboard, { RANGES } from '@/components/dashboard/useDashboard';
import SetupChecklist from '@/components/dashboard/SetupChecklist';
import ReferralCard from '@/components/dashboard/ReferralCard';
import TryMyAI from '@/components/dashboard/TryMyAI';
import OutcomesDueBanner from '@/components/pipeline/OutcomesDueBanner';

const usd = c => `$${Math.round((Number(c) || 0) / 100).toLocaleString()}`;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '');

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

function Section({ title, action, children, className = '' }) {
  return (
    <section className={`panel flex flex-col ${className}`}>
      <div className="flex h-12 items-center justify-between border-b px-4">
        <h2 className="section-title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ListSkeleton() {
  return <div className="divide-y">{[0, 1, 2].map(i => <div key={i} className="space-y-2 px-4 py-3.5"><Bone className="h-3.5 w-1/3" /><Bone className="h-3 w-2/3" /></div>)}</div>;
}

/** People waiting on the agent personally, longest-waiting reasons first. */
function NeedsYou({ data, loading }) {
  const c = stageColors('needs_you');
  return (
    <Section
      title={<span className="flex items-center gap-2">Needs you{data?.needsCount > 0 && <span className="rounded-md px-1.5 text-xs font-semibold tabular-nums" style={{ background: c.soft, color: c.ink }}>{data.needsCount}</span>}</span>}
      action={<Link to="/inbox?filter=needs_human" className="text-sm text-muted-foreground hover:text-foreground">Open in inbox</Link>}
    >
      {loading ? <ListSkeleton /> : !data?.needs.length ? (
        <EmptyState compact icon={CheckCheck} title="Nobody is waiting on you" description="When a lead asks something only you can answer, they show up here." />
      ) : (
        <ul className="divide-y">
          {data.needs.map(lead => (
            <li key={lead.id}>
              <Link to={`/inbox?lead=${lead.id}`} className="relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: c.dot }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="truncate text-sm font-medium">{[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone}</p>
                    {lead.last_inbound_at && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{shortAgo(lead.last_inbound_at)}</span>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{lead.needs_human_reason || 'Waiting on your reply'}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function UpcomingCalls({ data, loading, timezone }) {
  const day = iso => new Date(iso).toLocaleDateString('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' });
  const time = iso => new Date(iso).toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  return (
    <Section title="Upcoming calls" action={<Link to="/appointments" className="text-sm text-muted-foreground hover:text-foreground">Calendar</Link>}>
      {loading ? <ListSkeleton /> : !data?.upcoming.length ? (
        <EmptyState compact icon={CalendarDays} title="No calls in the next 7 days" description="Calls the AI books land here and on your calendar. More leads means more calls."><Button size="sm" variant="outline" asChild><Link to="/contacts/import">Import leads</Link></Button></EmptyState>
      ) : (
        <ul className="divide-y">
          {data.upcoming.map(a => (
            <li key={a.id}>
              <Link to={a.lead_id ? `/contacts/${a.lead_id}` : '/appointments'} className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50">
                <div className="w-20 shrink-0"><p className="text-sm font-medium tabular-nums">{time(a.start_time)}</p><p className="text-xs text-muted-foreground">{day(a.start_time)}</p></div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{a.lead_name || 'Lead'}</p><p className="truncate text-xs text-muted-foreground">{a.ai_summary || a.campaign_name || 'Booked by your AI'}</p></div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** All-time results, in one line of numbers. */
function Results() {
  const { data, isLoading } = useQuery({ queryKey: ['results'], queryFn: () => call('results', {}), staleTime: 60000 });
  const items = [
    ['Leads texted', data?.texted],
    ['Replied', data?.replied, pct(data?.replied, data?.texted)],
    ['Calls booked', data?.booked, pct(data?.booked, data?.replied)],
    ['Policies', data?.closed],
    ['Annual premium', data ? usd(data.annual_premium_cents) : undefined],
  ];
  return (
    <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-5" aria-label="All-time results">
      {items.map(([label, value, sub], i) => (
        <div key={label} className={`bg-card px-4 py-4 ${i === 4 ? 'col-span-2 sm:col-span-1' : ''}`}>
          <p className="text-xs text-muted-foreground">{label}</p>
          {isLoading ? <Bone className="mt-2 h-6 w-14" /> : <p className="mt-1 text-xl font-semibold tabular-nums">{value ?? 0}{sub && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{sub}</span>}</p>}
        </div>
      ))}
    </section>
  );
}

/** Activity in a period: texted → replied → booked → held, with the step-to-step rate. */
function Activity({ email }) {
  const [range, setRange] = useState('7d');
  const [campaign, setCampaign] = useState('all');
  const { data: campaigns } = useQuery({ queryKey: ['campaign-options', email], enabled: !!email, queryFn: () => base44.entities.Campaign.filter({ agent_email: email }, { limit: 50, fields: ['name'] }) });
  const { data, isLoading, error } = useDashboard(email, range, campaign);
  const steps = [['Texted', data?.texted, 'texting'], ['Replied', data?.replied, 'talking'], ['Booked', data?.booked, 'booked'], ['Held', data?.held, 'booked']];
  const max = Math.max(1, data?.texted || 0);
  return (
    <section className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="section-title">Activity</h2>
        <div className="flex items-center gap-2">
          {campaigns?.items?.length > 1 && (
            <select aria-label="Campaign" className="field h-8 min-h-8 w-auto py-0 text-sm" value={campaign} onChange={e => setCampaign(e.target.value)}>
              <option value="all">All campaigns</option>
              {campaigns.items.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Time range">
            {RANGES.map(r => <button key={r.key} type="button" role="tab" aria-selected={range === r.key} onClick={() => setRange(r.key)} className={`h-7 rounded px-2.5 text-[13px] transition-colors ${range === r.key ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{r.label}</button>)}
          </div>
        </div>
      </div>
      {error ? <p className="p-4 text-sm text-destructive">{error.message}</p> : (
        <div className="space-y-3 p-4">
          {steps.map(([label, value, tone], i) => {
            const c = stageColors(tone);
            const prev = i ? steps[i - 1][1] : null;
            return (
              <div key={label} className="grid grid-cols-[72px_1fr_88px] items-center gap-3">
                <span className="text-sm text-muted-foreground">{label}</span>
                <div className="h-6 overflow-hidden rounded bg-muted/60">
                  {!isLoading && <div className="h-full rounded transition-[width] duration-500" style={{ width: `${Math.max(value ? 1.5 : 0, ((value || 0) / max) * 100)}%`, background: c.dot }} />}
                </div>
                <span className="text-right text-sm tabular-nums">{isLoading ? '–' : <><span className="font-semibold">{value ?? 0}</span>{i > 0 && prev ? <span className="ml-1.5 text-xs text-muted-foreground">{pct(value, prev)}</span> : null}</>}</span>
              </div>
            );
          })}
          {!isLoading && data?.optOuts > 0 && <p className="pt-1 text-xs text-muted-foreground">{data.optOuts} opted out in this period.</p>}
        </div>
      )}
    </section>
  );
}

/** The one thing to do right now, once setup is finished (until then the setup checklist is the next step). */
function NextUp({ data, loading, timezone, onTry }) {
  return <><ThinCalendarBanner className="mb-4" /><NextUpInner data={data} loading={loading} timezone={timezone} onTry={onTry} /></>;
}

function NextUpInner({ data, loading, timezone, onTry }) {
  const launch = useQuery({ queryKey: ['launch'], queryFn: () => call('launch', {}), refetchInterval: 30000 });
  if (loading || launch.isLoading) return null;
  if (launch.data && !(launch.data.live && launch.data.items.every(i => i.done))) return null;
  const n = data?.needsCount || 0;
  const call0 = data?.upcoming?.[0];
  let title, detail, cta;
  if (n > 0) {
    title = n === 1 ? '1 lead is waiting on your reply' : `${n} leads are waiting on your reply`;
    detail = 'They asked something only you can answer. Reply while they are still warm.';
    cta = <Button size="lg" asChild><Link to="/inbox?filter=needs_human">Reply now<ArrowRight /></Link></Button>;
  } else if (call0) {
    const when = new Date(call0.start_time).toLocaleString('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    title = `Next call: ${call0.lead_name || 'a lead'}, ${when}`;
    detail = call0.ai_summary || 'Read the conversation before you call so you know what they asked.';
    cta = <Button size="lg" asChild><Link to={call0.lead_id ? `/contacts/${call0.lead_id}` : '/appointments'}>Prepare for the call<ArrowRight /></Link></Button>;
  } else {
    title = "You're all caught up";
    detail = 'Nobody is waiting on you. Import more leads to keep your AI booking calls.';
    cta = <><Button variant="outline" onClick={onTry}>Text your AI</Button><Button size="lg" asChild><Link to="/contacts/import">Import leads<ArrowRight /></Link></Button></>;
  }
  return (
    <section className="panel lr-rise flex flex-wrap items-center gap-x-6 gap-y-3 border-primary/40 p-5 ring-1 ring-primary/15" aria-label="Next step">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-primary">Do this next</p>
        <h2 className="mt-1 text-base font-semibold">{title}</h2>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{detail}</p>
      </div>
      <div className="flex gap-2">{cta}</div>
    </section>
  );
}

function PendingApprovals() {
  const { data } = useQuery({ queryKey: ['pending-approvals'], queryFn: () => call('adminAgents', { action: 'pending_count' }), refetchInterval: 60000, staleTime: 30000, retry: false });
  const n = data?.pending || 0;
  if (!n) return null;
  return (
    <Link to="/admin" className="panel flex items-center justify-between gap-4 p-4 transition-colors hover:border-primary/40">
      <span><span className="block text-sm font-medium">{n === 1 ? '1 new signup is' : `${n} new signups are`} waiting for your approval</span><span className="block text-sm text-muted-foreground">They can't create their workspace until you approve them.</span></span>
      <span className="shrink-0 text-sm font-medium text-primary">Review</span>
    </Link>
  );
}

export default function Dashboard() {
  const { settings, user } = useOutletContext();
  const email = user?.email;
  const [tryOpen, setTryOpen] = useState(false);
  const { data, isLoading } = useDashboard(email, '7d', 'all');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="space-y-6">
      <PageHeader
        title={greeting(settings.first_name)}
        description={today}
        actions={<>
          <Button variant="outline" onClick={() => setTryOpen(true)}>Text your AI</Button>
          <Button variant="outline" asChild><Link to="/inbox"><MessageSquare />Inbox</Link></Button>
        </>}
      />
      {user?.role === 'admin' && <PendingApprovals />}
      <SetupChecklist />
      <NextUp data={data} loading={isLoading} timezone={settings.home_timezone || 'America/Chicago'} onTry={() => setTryOpen(true)} />
      <OutcomesDueBanner />
      <div className="grid gap-6 lg:grid-cols-2">
        <NeedsYou data={data} loading={isLoading} />
        <UpcomingCalls data={data} loading={isLoading} timezone={settings.home_timezone || 'America/Chicago'} />
      </div>
      <Results />
      <Activity email={email} />
      <ReferralCard />
      <TryMyAI open={tryOpen} onClose={() => setTryOpen(false)} settings={settings} />
    </div>
  );
}
