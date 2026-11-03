import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, MoreHorizontal, UserX } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import PageHeader from '@/components/workspace/PageHeader';
import StatusChip from '@/components/workspace/StatusChip';
import TestLeadBadge from '@/components/contacts/TestLeadBadge';
import EmptyState from '@/components/workspace/EmptyState';
import { PageSkeleton } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import CallButton from '@/components/calls/CallButton';
import ContactTimeline from '@/components/contacts/ContactTimeline';
import { ContactFacts, ContactNotes } from '@/components/contacts/ContactBrain';
import ContactEnrollment from '@/components/contacts/ContactEnrollment';
import WebsiteInquiryRetry from '@/components/contacts/WebsiteInquiryRetry';
import BookCallDialog from '@/components/appointments/BookCallDialog';
import OutcomeDialog from '@/components/pipeline/OutcomeDialog';

const pretty = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
const TRACK = { no_show: 'No-show follow-up', follow_up: 'Post-call follow-up', lost_banking: 'Banking objection', lost_social: 'SSN objection', client: 'Client' };

function Row({ label, children }) {
  return <div className="flex justify-between gap-4 py-2 text-sm"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words text-right">{children || <span className="text-muted-foreground">—</span>}</dd></div>;
}

function Details({ c }) {
  const eligibility = c.eligibility_reason || (c.state_eligible ? 'Licensed state' : 'Not verified');
  return (
    <section className="panel">
      <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">Details</h2></div>
      <dl className="divide-y px-4">
        <Row label="Phone">{c.phone ? <a href={`tel:${c.phone}`} className="hover:underline">{pretty(c.phone)}</a> : null}</Row>
        <Row label="Email">{c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : null}</Row>
        <Row label="State">{c.state}</Row>
        <Row label="Time zone">{(c.timezone || '').replace(/_/g, ' ')}</Row>
        <Row label="Texts from">{c.from_number ? pretty(c.from_number) : null}</Row>
        <Row label="Source">{c.lead_source}</Row>
        <Row label="Inquired">{c.inquiry_date}</Row>
        <Row label="Eligibility">{eligibility}</Row>
      </dl>
    </section>
  );
}

function Pipeline({ c, onLog }) {
  const { data } = useQuery({ queryKey: ['contact', c.id, 'policy'], enabled: c.track === 'client', queryFn: () => call('outcomes', { action: 'policy', lead_id: c.id }) });
  const p = data?.policy;
  return (
    <section className="panel">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <h2 className="section-title">After the call</h2>
        {c.track !== 'client' && c.status !== 'opted_out' && <Button size="sm" variant="ghost" onClick={onLog}>Log outcome</Button>}
      </div>
      <div className="p-4 text-sm">
        {p ? (
          <dl className="divide-y">
            <Row label="Carrier">{p.carrier}</Row><Row label="Product">{p.product}</Row><Row label="Policy">#{p.policy_number}</Row>
            <Row label="Coverage">{p.coverage}</Row><Row label="Premium">{p.premium}</Row><Row label="Status">{p.status === 'submitted' ? 'Waiting on approval' : p.status}</Row>
            <div className="pt-2"><Link to="/clients" className="text-sm font-medium text-primary hover:underline">Manage in Clients</Link></div>
          </dl>
        ) : c.track ? (
          <p>{TRACK[c.track]}{c.last_disposition_at ? <span className="text-muted-foreground">, logged {new Date(c.last_disposition_at).toLocaleDateString()}</span> : ''}{c.disposition_note ? <span className="mt-1 block text-muted-foreground">{c.disposition_note}</span> : null}</p>
        ) : (
          <p className="text-muted-foreground">After you talk to them, log what happened and the right follow-up texts start on their own.</p>
        )}
      </div>
    </section>
  );
}

function Consent({ c }) {
  return (
    <section className="panel">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <h2 className="section-title">Consent</h2>
        <Link to={`/contacts/${c.id}/consent`} className="text-sm text-muted-foreground hover:text-foreground">Full record</Link>
      </div>
      <dl className="divide-y px-4">
        <Row label="Source">{c.consent_source}</Row>
        <Row label="Date">{c.consent_date ? new Date(c.consent_date).toLocaleDateString() : null}</Row>
        <Row label="Seller named">{c.consent_seller_named}</Row>
        <Row label="DNC check">{c.dnc_checked ? 'Done' : 'Not recorded'}</Row>
      </dl>
    </section>
  );
}

export default function ContactDetail() {
  const { id } = useParams();
  const [booking, setBooking] = useState(false);
  const [logging, setLogging] = useState(false);
  const { data: c, isLoading, error } = useQuery({ queryKey: ['contact', id], queryFn: () => base44.entities.Lead.get(id) });

  if (isLoading) return <PageSkeleton />;
  if (error || !c) return <EmptyState icon={UserX} title="This lead isn't available" description="It may have been removed, or it belongs to another account."><Button asChild variant="outline"><Link to="/contacts">Back to leads</Link></Button></EmptyState>;

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || pretty(c.phone) || 'Unnamed lead';
  const canText = !['opted_out'].includes(c.status);

  return (
    <div>
      <PageHeader
        back={{ to: '/contacts', label: 'Leads' }}
        title={name}
        actions={<>
          {c.phone && <CallButton leadId={id} variant="default" size="default" label="Call" />}
          <Button variant="outline" asChild><Link to={`/inbox?lead=${id}`}><MessageSquare />Texts</Link></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canText && <DropdownMenuItem onSelect={() => setBooking(true)}>Book a call</DropdownMenuItem>}
              {c.track !== 'client' && c.status !== 'opted_out' && <DropdownMenuItem onSelect={() => setLogging(true)}>Log call outcome</DropdownMenuItem>}
              <DropdownMenuItem asChild><Link to={`/contacts/${id}/consent`}>Consent record</Link></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
      >
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <StatusChip status={c.status} track={c.track} />
          <TestLeadBadge phone={c.phone} />
          {c.phone && <span>{pretty(c.phone)}</span>}
          {c.state && <span>{c.state}</span>}
        </div>
        {c.status === 'needs_human' && c.needs_human_reason && <p className="mt-3 rounded-md border px-3 py-2 text-sm" style={{ background: 'hsl(var(--st-needs_you) / 0.06)', borderColor: 'hsl(var(--st-needs_you) / 0.35)' }}><span className="font-medium">Needs you:</span> {c.needs_human_reason}</p>}
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          {c.ai_summary && <section className="panel p-4"><h2 className="section-title">Summary</h2><p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{c.ai_summary}</p></section>}
          <ContactNotes leadId={c.id} />
          <ContactFacts leadId={c.id} />
          <ContactTimeline id={id} />
        </div>
        <aside className="space-y-6">
          <Details c={c} />
          <Pipeline c={c} onLog={() => setLogging(true)} />
          <Consent c={c} />
          <WebsiteInquiryRetry contact={c} />
          <ContactEnrollment key={c.id} contact={c} />
        </aside>
      </div>

      <BookCallDialog open={booking} onOpenChange={setBooking} lead={c} />
      {logging && <OutcomeDialog open={logging} onOpenChange={setLogging} lead={c} />}
    </div>
  );
}
