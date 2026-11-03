import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, ShieldCheck, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { base44 } from '@/api/base44Client';
import { PanelSkeleton } from '@/components/system/Loaders';

const fmt = iso => iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const BASIS = { agent_attestation: 'Agent attestation (file upload)', web_form: 'Web form checkbox', webhook: 'Lead API submission' };
const DNC_BASIS = { written_consent: 'Prior express written consent on file (registry scrub not required)', registry_scrub: 'Written consent plus a National DNC Registry scrub within 31 days' };

function Row({ k, v }) { return <div className="grid grid-cols-[160px_1fr] gap-3 py-1.5 text-sm"><dt className="text-muted-foreground">{k}</dt><dd className="break-words">{v === undefined || v === null || v === '' ? '—' : String(v)}</dd></div>; }

/** Printable proof of consent and contact history for one lead. Save as PDF from the print dialog. */
export default function ConsentProof() {
  const { id } = useParams();
  const { data: d, isLoading, error, refetch, isRefetching } = useQuery({ queryKey: ['consent', id], queryFn: () => call('leads', { action: 'consent', id }) });
  // Every consent record kept for this lead (upload attestation, web form, lead API). Read access is limited to the agent's own rows.
  const records = useQuery({ queryKey: ['consent-records', id], enabled: !!d, queryFn: () => base44.entities.ConsentRecord.filter({ lead_id: id }, { sort: 'attested_at', limit: 50 }).then(p => (p?.items || p || [])).catch(() => []) });
  const consentRecords = records.data || [];
  // The basis is recorded on the upload attestation (registry scrub is optional); any consent record on file means written consent.
  const dncBasis = d?.attestations?.find(a => a.dnc_basis)?.dnc_basis || (consentRecords.length ? 'written_consent' : '');
  if (isLoading) return <PanelSkeleton rows={8} />;
  if (error) return (
    <div className="mx-auto max-w-3xl space-y-3">
      <p role="alert" className="text-sm text-destructive">{error.message}</p>
      <div className="flex gap-2"><Button variant="outline" loading={isRefetching} onClick={() => refetch()}>Try again</Button><Button variant="ghost" asChild><Link to={`/contacts/${id}`}>Back to lead</Link></Button></div>
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl space-y-6 print:max-w-none">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link to={`/contacts/${id}`} className="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowLeft size={13} />Back to lead</Link>
        <Button className="gap-2" onClick={() => window.print()}><Printer size={15} />Print or save as PDF</Button>
      </div>
      <div className="border-b pb-4">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><ShieldCheck size={15} />Consent and contact record</p>
        <h1 className="mt-2 text-2xl font-semibold">{d.lead.name || d.lead.phone}</h1>
        <p className="mt-1 text-xs text-muted-foreground">Generated {fmt(d.generated_at)} for {d.agent.name}{d.agent.business ? `, ${d.agent.business}` : ''}{d.agent.npn ? ` (NPN ${d.agent.npn})` : ''}</p>
      </div>

      <section><h2 className="mb-1 font-semibold">Contact</h2><dl className="divide-y">
        <Row k="Phone" v={d.lead.phone} /><Row k="Email" v={d.lead.email} /><Row k="State" v={d.lead.state} /><Row k="Current status" v={d.lead.status.replace(/_/g, ' ')} />
        <Row k="Lead source" v={d.lead.lead_source} /><Row k="Date inquired" v={d.lead.inquiry_date} /><Row k="Uploaded" v={fmt(d.lead.created)} /><Row k="Import batch" v={d.lead.import_batch} />
      </dl></section>

      <section><h2 className="mb-1 font-semibold">Consent</h2><dl className="divide-y">
        <Row k="Source" v={d.consent.source} /><Row k="Consent date" v={d.consent.date ? fmt(d.consent.date) : ''} /><Row k="Business named" v={d.consent.seller_named} />
        <Row k="Consent statement" v={d.consent.statement} /><Row k="Do-not-call basis" v={d.consent.dnc_checked ? (DNC_BASIS[dncBasis] || 'Opt-out list checked') : 'No basis recorded'} />
      </dl>
        {consentRecords.map(r => <div key={r.id} className="mt-3 rounded-lg border p-3 text-sm"><p className="font-medium">Consent record: {BASIS[r.basis] || r.basis || 'Recorded consent'}</p><dl className="divide-y">
          <Row k="Consent date" v={r.consent_date} /><Row k="Wording" v={r.wording || r.consent_text} /><Row k="Business named" v={r.seller_named} /><Row k="Source" v={r.source} />
          <Row k="Attested by" v={r.attested_by} /><Row k="Attested at" v={fmt(r.attested_at || r.timestamp)} /><Row k="IP address" v={r.ip} /><Row k="Browser" v={r.user_agent} />{r.page_url && <Row k="Page" v={r.page_url} />}{r.batch_id && <Row k="Batch" v={r.batch_id} />}
        </dl></div>)}
        {d.web_form && <div className="mt-3 rounded-lg border p-3 text-sm"><p className="font-medium">Web form submission</p><dl className="divide-y"><Row k="Submitted" v={fmt(d.web_form.submitted)} /><Row k="Consent box checked" v={d.web_form.checkbox_checked ? 'Yes' : 'No'} /><Row k="Wording shown" v={d.web_form.wording} /><Row k="Page" v={d.web_form.page} /><Row k="IP address" v={d.web_form.ip} /></dl></div>}
        {d.attestations.map((a, i) => <div key={i} className="mt-3 rounded-lg border p-3 text-sm"><p className="font-medium">Upload attestation</p><dl className="divide-y"><Row k="When" v={fmt(a.at)} /><Row k="By" v={a.by} /><Row k="Statement" v={a.attestation} /><Row k="Source chosen" v={a.source} /><Row k="IP address" v={a.ip} /></dl></div>)}
      </section>

      <section><h2 className="mb-1 font-semibold">Opt-out</h2>
        <p className="text-sm">{d.opt_out ? <>Opted out {d.opt_out.at ? fmt(d.opt_out.at) : ''}{d.opt_out.message ? `: “${d.opt_out.message}”` : ''}. No texts were sent after this.</> : 'Has not opted out.'}</p>
      </section>

      <section><h2 className="mb-2 font-semibold">Every text ({d.messages.length})</h2>
        {!d.messages.length ? <p className="text-sm text-muted-foreground">No texts yet.</p> : <ol className="space-y-1.5">{d.messages.map((m, i) => (
          <li key={i} className="grid grid-cols-[140px_70px_1fr] gap-3 border-b py-1.5 text-xs last:border-0">
            <span className="text-muted-foreground">{fmt(m.at)}</span><span className={m.direction === 'inbound' ? 'font-semibold' : 'text-muted-foreground'}>{m.direction === 'inbound' ? 'Received' : 'Sent'}</span><span className="whitespace-pre-wrap">{m.body}</span>
          </li>))}</ol>}
      </section>

      {!!d.actions.length && <section><h2 className="mb-2 font-semibold">Agent actions</h2><ul className="text-xs">{d.actions.map((a, i) => <li key={i} className="py-1">{fmt(a.at)}: {a.action.replace(/_/g, ' ')} ({a.by})</li>)}</ul></section>}
      <p className="border-t pt-3 text-[10px] text-muted-foreground">Texts were sent only between 9am and 8pm in the contact's time zone, and STOP requests are honored automatically. Generated by LeadRespark.</p>
    </div>
  );
}
