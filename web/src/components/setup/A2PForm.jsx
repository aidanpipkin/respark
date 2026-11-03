import { useMemo, useRef, useState } from 'react';
import { notify } from '@/lib/feedback';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { Building2, User, CheckCircle2, ChevronDown, Sparkles } from 'lucide-react';

const ENTITY_TYPES = ['Limited Liability Corporation', 'Corporation', 'Partnership', 'Co-operative', 'Non-profit Corporation'];
const POSITIONS = ['Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other'];
const PROGRAM = ['description', 'opt_in_flow', 'sample_message_1', 'sample_message_2', 'stop_response', 'help_response'];
const LONG = [['description', 'What you text about'], ['opt_in_flow', 'How people opt in'], ['sample_message_1', 'Sample message 1'], ['sample_message_2', 'Sample message 2'], ['stop_response', 'Reply to STOP'], ['help_response', 'Reply to HELP']];

function Field({ label, hint, children }) { return <label className="block"><span className="field-label">{label}</span>{children}{hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}</label>; }
const swap = (text, from, to) => (from && to && from !== to ? String(text || '').split(from).join(to) : String(text || ''));

export default function A2PForm({ data, onSaved }) {
  const p = data.profile, r = data.registration || {}, rec = data.program || {}, site = data.site;
  const brand = r.legal_business_name || p.legal_business_name || `${p.first_name} ${p.last_name}`.trim();
  const savedCopy = !!(r.sample_message_1 || r.description) && !(r.status === 'rejected' && r.provider_step === 'campaign');
  const [form, setForm] = useState({
    business_type: r.business_type || 'company', entity_type: r.entity_type || 'Limited Liability Corporation', legal_business_name: brand,
    first_name: r.first_name || p.first_name, last_name: r.last_name || p.last_name, npn: r.npn || p.npn, rep_title: r.rep_title || 'Owner', rep_position: r.rep_position || 'CEO',
    mobile_phone: r.mobile_phone || p.alert_mobile, business_email: r.business_email || p.business_email, business_phone: r.business_phone || p.business_phone,
    street: r.street || p.street, city: r.city || p.city, region: r.region || p.region, postal_code: r.postal_code || p.postal_code,
    website: r.website || site?.url || '', privacy_url: r.privacy_url || site?.privacy_url || '', terms_url: r.terms_url || site?.terms_url || '',
    ...Object.fromEntries(PROGRAM.map(k => [k, r[k] || ''])),
    attested: false,
  });
  // Until the agent edits the program copy, it is the recommended copy, re-filled on the server at submit time.
  const [custom, setCustom] = useState(savedCopy);
  const [open, setOpen] = useState(false);
  const [ein, setEin] = useState(''), [busy, setBusy] = useState(''), [errors, setErrors] = useState([]), [flash, setFlash] = useState(0);
  const errorsRef = useRef(null);
  const sole = form.business_type === 'sole_proprietor';
  // Campaign sent back by the carriers while the brand stayed approved: only the program wording is resubmitted.
  const campaignFix = r.status === 'rejected' && r.provider_step === 'campaign' && !!r.brand_sid;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const input = (k, props = {}) => <input className="field" maxLength={4000} value={form[k] || ''} onChange={e => set(k, e.target.value)} {...props} />;

  const baseBrand = p.legal_business_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
  const shown = useMemo(() => {
    if (custom) return form;
    const name = form.legal_business_name || `${form.first_name} ${form.last_name}`.trim();
    const fix = t => swap(swap(t, baseBrand, name), p.first_name, form.first_name);
    return { ...form, ...Object.fromEntries(PROGRAM.map(k => [k, fix(rec[k])])) };
  }, [custom, form, rec, baseBrand, p.first_name]);
  const extras = (rec.extra_samples || []).map(t => swap(swap(t, baseBrand, form.legal_business_name), p.first_name, form.first_name));
  const usingSite = site && form.website === site.url;

  function editProgram(k, v) { if (!custom) { setForm(f => ({ ...f, ...Object.fromEntries(PROGRAM.map(x => [x, shown[x]])), [k]: v })); setCustom(true); } else set(k, v); }
  function resetProgram() { setForm(f => ({ ...f, ...Object.fromEntries(PROGRAM.map(k => [k, ''])), website: site?.url || f.website, privacy_url: site?.privacy_url || f.privacy_url, terms_url: site?.terms_url || f.terms_url })); setCustom(false); }

  async function act(action) {
    setBusy(action); setErrors([]);
    try {
      if (action === 'generate') { const res = await call('a2pDraft', form); setForm(f => ({ ...f, ...res.draft })); setCustom(true); setOpen(true); setFlash(n => n + 1); notify.ok('Rewritten with AI', 'Every line was checked against carrier rules. Review it below.'); return; }
      const body = custom ? form : { ...form, ...Object.fromEntries(PROGRAM.map(k => [k, ''])) };
      if (action === 'save') { await call('a2pSubmit', { ...body, draft: true }); await onSaved(); notify.ok('Draft saved', 'Come back and submit whenever you are ready.', { label: 'Next: Calendar', to: '/setup/calendar' }); return; }
      const res = await call('a2pSubmit', { ...body, ...(sole ? {} : { ein }) }); setEin('');
      await onSaved();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (res.status === 'waiting_platform') notify.ok('Registration saved', "Our provider is finishing a one-time setup. We'll text and email you when it's time to press Submit. Nothing else to do now.", { label: 'Next: Calendar', to: '/setup/calendar' });
      else if (res.resubmitted) notify.ok('Campaign resubmitted', res.review_note || 'Carriers usually answer in 1 to 7 business days. We track it and turn texting on automatically.', { label: 'Next: Calendar', to: '/setup/calendar' });
      else notify.ok('Registration submitted', res.review_note || `Carriers usually approve in 1 to 7 business days. We track it and turn texting on automatically.${sole ? ' Watch for a verification text and reply YES.' : ''} Meanwhile, set up your calendar.`, { label: 'Next: Calendar', to: '/setup/calendar' });
    } catch (e) {
      setErrors(String(e.message).split(/(?<=\.)\s+(?=[A-Z])|\s\|\s/).filter(Boolean));
      notify.err(action === 'generate' ? e : 'Fix the items listed at the bottom of the form, then try again.', action === 'submit' ? 'Registration not submitted' : action === 'save' ? 'Draft not saved' : 'Could not rewrite with AI');
      setTimeout(() => errorsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    } finally { setBusy(''); }
  }
  const canSubmit = form.attested && (sole || campaignFix || ein.replace(/\D/g, '').length === 9) && !busy;

  return (
    <form className="panel space-y-6 p-5" onSubmit={e => { e.preventDefault(); if (canSubmit) act('submit'); }}>
      {campaignFix && <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm"><p className="font-medium">Your business is verified. Only the campaign wording needs another pass.</p><p className="mt-1 text-muted-foreground">We have updated the program description below to the carriers' format. Review it, tick the confirmation and press Resubmit. No EIN needed; your approved brand stays as it is.</p></div>}
      <div>
        <h2 className="font-semibold">Register for business texting</h2>
        <p className="subtext mt-1">Carriers require every business that texts to register (A2P 10DLC). We've already written your texting program, sample messages and opt-in details to carrier standards. You just confirm who you are. {data.a2p_automatic ? 'We submit it and track approval automatically.' : 'Your administrator submits it for you.'}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {[['company', Building2, 'I have an EIN', 'LLC, corporation or partnership. Higher sending limits.'], ['sole_proprietor', User, 'No EIN (sole proprietor)', 'Register with your own name. One number, lower daily volume.']].map(([v, Icon, t, d]) =>
          <button key={v} type="button" onClick={() => set('business_type', v)} className={`rounded-lg border p-4 text-left transition ${form.business_type === v ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50'}`}><Icon size={18} className="mb-2" /><p className="font-semibold text-sm">{t}</p><p className="mt-1 text-xs text-muted-foreground">{d}</p></button>)}
      </div>

      <fieldset disabled={!!busy} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="First name">{input('first_name')}</Field>
          <Field label="Last name">{input('last_name')}</Field>
          <Field label="NPN" hint="Your National Producer Number.">{input('npn', { inputMode: 'numeric' })}</Field>
        </div>

        {sole ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand name" hint="Usually your full name or your DBA.">{input('legal_business_name')}</Field>
            <Field label="Your mobile number" hint="The carrier texts this phone a code; reply YES to verify. Not your texting number.">{input('mobile_phone', { inputMode: 'tel' })}</Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Legal business name" hint="Exactly as on your IRS EIN letter.">{input('legal_business_name')}</Field>
            <Field label="Business type"><select className="field" value={form.entity_type} onChange={e => set('entity_type', e.target.value)}>{ENTITY_TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
            {!campaignFix && <Field label="EIN" hint={r.ein_last4 ? `Previously submitted EIN ending ${r.ein_last4}. Enter it again to resubmit.` : 'Sent directly to the carrier registry. Never stored here.'}><input className="field" type="password" autoComplete="off" inputMode="numeric" placeholder="12-3456789" value={ein} onChange={e => setEin(e.target.value)} /></Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Your title">{input('rep_title')}</Field>
              <Field label="Position"><select className="field" value={form.rep_position} onChange={e => set('rep_position', e.target.value)}>{POSITIONS.map(t => <option key={t}>{t}</option>)}</select></Field>
            </div>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email">{input('business_email', { type: 'email' })}</Field>
          <Field label="Business phone">{input('business_phone', { inputMode: 'tel' })}</Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_80px_110px]">
          <Field label="Street address" hint={sole ? 'Your home or business address.' : 'Must match your IRS record.'}>{input('street')}</Field>
          <Field label="City">{input('city')}</Field>
          <Field label="State">{input('region', { maxLength: 2 })}</Field>
          <Field label="ZIP">{input('postal_code', { inputMode: 'numeric' })}</Field>
        </div>

        <div className="rounded-lg border bg-muted/30">
          <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-start justify-between gap-3 p-4 text-left">
            <span className="flex items-start gap-3">
              <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
              <span>
                <span className="block text-sm font-semibold">Texting program: done for you</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {custom ? 'Using your edited copy.' : 'Recommended copy written to carrier review rules.'} Program description, opt-in process{usingSite ? ' (your hosted LeadRespark form)' : ''}, privacy policy and SMS terms, {2 + extras.length} sample messages, and STOP/HELP replies.
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-primary">{open ? 'Hide' : 'Review'}<ChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} /></span>
          </button>
          {open && <div key={flash} className={`space-y-4 border-t p-4 ${flash ? 'lr-done' : ''}`}>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" loading={busy === 'generate'} onClick={() => act('generate')}>{busy !== 'generate' && <Sparkles size={14} />}{busy === 'generate' ? 'Writing…' : 'Rewrite with AI'}</Button>
              {custom && <Button type="button" variant="ghost" size="sm" onClick={resetProgram}>Reset to recommended</Button>}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Business website" hint={usingSite ? 'Your hosted compliant page.' : 'Privacy and terms must be on this site.'}><input className="field" value={form.website} onChange={e => editProgram('website', e.target.value)} /></Field>
              <Field label="Privacy policy link"><input className="field" value={form.privacy_url} onChange={e => editProgram('privacy_url', e.target.value)} /></Field>
              <Field label="SMS terms link"><input className="field" value={form.terms_url} onChange={e => editProgram('terms_url', e.target.value)} /></Field>
            </div>
            {LONG.map(([k, label]) => <Field key={k} label={label}><textarea className="field min-h-20" maxLength={2048} value={shown[k] || ''} onChange={e => editProgram(k, e.target.value)} /></Field>)}
            {!!extras.length && <Field label="Also sent as samples" hint="Standard reminder and client-service examples, added automatically.">{extras.map((t, i) => <p key={i} className="mt-1 rounded-lg bg-background p-2 text-xs">{t}</p>)}</Field>}
          </div>}
        </div>

        <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={form.attested} onChange={e => set('attested', e.target.checked)} />I confirm this information is accurate, that I only text people who gave consent naming my business as described above, and that I am a licensed insurance agent. I understand texting stays off until the carriers approve.</label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!canSubmit && busy !== 'submit'} loading={busy === 'submit'}>{busy === 'submit' ? 'Submitting to carriers… (up to a minute)' : campaignFix ? 'Resubmit campaign' : 'Submit registration'}</Button>
          <Button type="button" variant="ghost" loading={busy === 'save'} onClick={() => act('save')}>{busy === 'save' ? 'Saving…' : 'Save and finish later'}</Button>
          {!canSubmit && !busy && <span className="text-xs text-muted-foreground">{!sole && !campaignFix && ein.replace(/\D/g, '').length !== 9 ? 'Enter your 9-digit EIN' : 'Tick the confirmation box'} to submit.</span>}
        </div>
      </fieldset>
      {!!errors.length && <ul ref={errorsRef} role="alert" className="list-disc space-y-1 rounded-lg bg-destructive/5 p-4 pl-8 text-sm text-destructive">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </form>
  );
}
