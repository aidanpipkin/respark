import { Link } from 'react-router-dom';

function Field({ label, value }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right">{value || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

/** Who this person is, what the AI has learned, and the consent behind texting them. */
export default function LeadProfile({ data }) {
  const p = data?.profile || {};
  const lead = data?.lead;
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Contact';
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-[15px] font-semibold">{name}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{p.phone || 'No phone on file'}</p>
        {p.email && <p className="text-sm text-muted-foreground">{p.email}</p>}
        {lead?.id && <Link to={`/contacts/${lead.id}`} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">Open lead</Link>}
      </div>

      <dl className="divide-y border-y">
        <Field label="State" value={p.state} />
        <Field label="Time zone" value={(lead?.timezone || p.timezone || '').replace(/_/g, ' ')} />
        <Field label="Source" value={lead?.lead_source || p.source} />
        <Field label="Inquired" value={lead?.inquiry_date} />
      </dl>

      <div>
        <h4 className="text-sm font-medium">What the AI knows</h4>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{lead?.ai_summary || 'Nothing yet. A summary appears after they reply.'}</p>
        {(lead?.ai_intent || lead?.ai_sentiment) && <p className="mt-2 text-xs text-muted-foreground">{[lead.ai_intent && `Intent: ${lead.ai_intent}`, lead.ai_sentiment && `Mood: ${lead.ai_sentiment}`].filter(Boolean).join('. ')}</p>}
      </div>

      {p.tags?.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">Tags</h4>
          <div className="mt-2 flex flex-wrap gap-1.5">{p.tags.map(t => <span key={t} className="rounded-md bg-muted px-2 py-0.5 text-xs">{t}</span>)}</div>
        </div>
      )}

      <div>
        <h4 className="text-sm font-medium">Consent</h4>
        <dl className="mt-1">
          <Field label="Source" value={lead?.consent_source} />
          <Field label="Date" value={lead?.consent_date ? new Date(lead.consent_date).toLocaleDateString() : ''} />
          <Field label="DNC check" value={lead?.dnc_checked ? 'Done' : 'Not recorded'} />
          <Field label="Texting" value={p.dnd || lead?.status === 'opted_out' ? 'Opted out' : 'Allowed'} />
        </dl>
        {lead?.id && <Link to={`/contacts/${lead.id}/consent`} className="mt-2 inline-block text-sm text-muted-foreground hover:text-foreground hover:underline">Full consent record</Link>}
      </div>
    </div>
  );
}
