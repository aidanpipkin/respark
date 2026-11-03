import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { CheckCircle2, Circle, Loader2, XCircle, Smartphone } from 'lucide-react';
import { notify } from '@/lib/feedback';

export default function A2PStatus({ registration, onChange }) {
  const [busy, setBusy] = useState(''), [flash, setFlash] = useState(0);
  const r = registration, sole = r.business_type === 'sole_proprietor';
  const order = ['brand_submitted', 'otp_pending', 'campaign_submitted', 'approved'];
  const at = r.status === 'rejected' ? -1 : order.indexOf(r.status);
  const steps = [
    ['Registration submitted', at >= 0],
    ['Brand approved by carriers', at >= (sole ? 1 : 2) || r.brand_status === 'APPROVED'],
    ...(sole ? [['Your phone verified (reply YES)', at >= 2 || r.identity_status === 'VERIFIED']] : []),
    ['Texting campaign approved', r.status === 'approved'],
  ];
  const current = steps.findIndex(([, done]) => !done);

  async function run(action) {
    setBusy(action);
    try {
      await call('a2pStatus', { action }); await onChange();
      if (action === 'resend_otp') notify.ok('Verification text sent', `Reply YES from ${r.mobile_phone || 'your mobile'} to verify.`);
      else { notify.ok('Status checked', 'Everything below is up to date. We keep checking every 30 minutes.'); setFlash(n => n + 1); }
    } catch (e) { notify.err(e, action === 'resend_otp' ? 'Text not sent' : 'Could not check status'); } finally { setBusy(''); }
  }

  return (
    <section key={flash} className={`panel space-y-5 p-5 ${flash ? 'lr-done' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{r.status === 'approved' ? 'You are approved for texting' : r.status === 'rejected' ? 'Registration needs changes' : 'Registration in progress'}</h2>
          <p className="subtext mt-1">{r.legal_business_name} · {sole ? 'Sole proprietor' : 'Standard brand'}{r.ein_last4 ? ` · EIN ••${r.ein_last4}` : ''}</p>
        </div>
        {!['approved', 'rejected'].includes(r.status) && <Button type="button" variant="outline" size="sm" disabled={!!busy} loading={busy === 'refresh'} onClick={() => run('refresh')}>{busy === 'refresh' ? 'Checking…' : 'Check status now'}</Button>}
      </div>

      {r.status !== 'rejected' && <ol className="space-y-3">{steps.map(([label, done], i) => <li key={label} className="flex items-center gap-3 text-sm">{done ? <CheckCircle2 size={18} className="text-success" /> : i === current ? <Loader2 size={18} className="animate-spin text-primary" /> : <Circle size={18} className="text-muted-foreground" />}<span className={done ? '' : i === current ? 'font-medium' : 'text-muted-foreground'}>{label}</span></li>)}</ol>}
      {r.status === 'rejected' && <div className="flex gap-3 text-sm"><XCircle size={18} className="mt-0.5 shrink-0 text-destructive" /><p>{r.review_note}</p></div>}
      {r.status !== 'rejected' && r.review_note && <p className="rounded-lg bg-muted/50 p-4 text-sm">{r.review_note}</p>}

      {r.status === 'otp_pending' && <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm"><Smartphone size={18} /><span className="flex-1">Didn't get the text, or it expired?</span><Button type="button" size="sm" disabled={!!busy} loading={busy === 'resend_otp'} onClick={() => run('resend_otp')}>{busy === 'resend_otp' ? 'Sending…' : 'Resend verification text'}</Button></div>}
      {r.status === 'rejected' && <p className="text-sm text-muted-foreground">Update your details in the form below and submit again.</p>}
      {r.last_checked_at && <p className="text-[11px] text-muted-foreground">Last checked {new Date(r.last_checked_at).toLocaleString()}. We check automatically every 30 minutes.</p>}
    </section>
  );
}
