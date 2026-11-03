import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { call, states } from '@/components/workspace/api';
import { Phone, Mail, MapPin, ShieldCheck, CheckCircle2 } from 'lucide-react';

const PRODUCTS = ['IUL', 'Term', 'Whole Life', 'Final Expense', 'Mortgage Protection', 'Unknown'];
const PRODUCT_LABEL = { IUL: 'Indexed Universal Life (IUL)', Term: 'Term Life', 'Whole Life': 'Whole Life', 'Final Expense': 'Final Expense', 'Mortgage Protection': 'Mortgage Protection', Unknown: 'Not sure yet' };
const EFFECTIVE = 'October 21, 2026';

function useSite(slug) {
  return useQuery({ queryKey: ['agent-site', slug], queryFn: () => call('getPublicSite', { slug }), retry: 0, staleTime: 300000 });
}

function Shell({ site, slug, children }) {
  const color = /^#[0-9a-f]{6}$/i.test(site.primary_color || '') ? site.primary_color : '#1f3a5f';
  const base = `/a/${slug}`;
  return (
    <div className="min-h-screen bg-white text-slate-800" style={{ '--brand': color }}>
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4">
          <Link to={base} className="flex items-center gap-3">
            {site.logo_url ? <img src={site.logo_url} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="flex h-10 w-10 items-center justify-center rounded text-lg font-bold text-white" style={{ background: color }}>{site.business_name?.[0] || 'A'}</span>}
            <span><span className="block font-semibold leading-tight">{site.brand_name || site.business_name}</span><span className="block text-xs text-slate-500">{site.agent_title || 'Licensed Life Insurance Agent'}</span></span>
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm">
            <Link to={base} className="hover:underline">Home</Link>
            <Link to={`${base}/privacy`} className="hover:underline">Privacy</Link>
            <Link to={`${base}/sms-terms`} className="hover:underline">SMS Terms</Link>
            <Link to={`${base}/get-info`} className="rounded-md px-3 py-1.5 font-medium text-white" style={{ background: color }}>Request info</Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
      <footer className="border-t bg-slate-50">
        <div className="mx-auto grid max-w-5xl gap-4 px-4 py-8 text-xs text-slate-600 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="font-semibold text-slate-800">{site.business_name}</p>
            {site.business_address && <p>{site.business_address}</p>}
            {site.business_phone && <p>{site.business_phone}</p>}
            {site.business_email && <p>{site.business_email}</p>}
          </div>
          <div className="space-y-1 sm:text-right">
            {!!site.licensed_states?.length && <p>Licensed in {site.licensed_states.join(', ')}</p>}
            {site.npn && <p>NPN {site.npn}</p>}
            <p><Link to={`${base}/privacy`} className="underline">Privacy Policy</Link> · <Link to={`${base}/sms-terms`} className="underline">SMS Terms</Link></p>
            <p>© {new Date().getFullYear()} {site.business_name}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Home({ site, slug }) {
  return (
    <div className="space-y-12">
      <section className="grid items-center gap-8 md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--brand)' }}>{site.business_name}</p>
          <h1 className="mt-3 text-3xl font-bold leading-tight sm:text-4xl">Talk with {site.display_name} about protecting the people who count on you.</h1>
          <p className="mt-4 text-slate-600">Straightforward life insurance guidance from a licensed agent. Ask questions, compare options, and decide on your own timeline. Coverage depends on eligibility, carrier underwriting and policy terms.</p>
          <Link to={`/a/${slug}/get-info`} className="mt-6 inline-block rounded-md px-5 py-3 font-medium text-white" style={{ background: 'var(--brand)' }}>Request information</Link>
        </div>
        {site.headshot_url && <img src={site.headshot_url} alt={site.display_name} className="mx-auto aspect-square w-60 rounded-2xl object-cover" />}
      </section>
      {!!site.products?.length && <section><h2 className="text-xl font-semibold">Coverage I help with</h2><ul className="mt-4 grid gap-3 sm:grid-cols-3">{site.products.map(p => <li key={p} className="flex items-center gap-2 rounded-lg border p-4 text-sm"><CheckCircle2 size={16} style={{ color: 'var(--brand)' }} />{PRODUCT_LABEL[p] || p}</li>)}</ul></section>}
      {site.about_text && <section><h2 className="text-xl font-semibold">About {site.display_name}</h2><p className="mt-3 whitespace-pre-line text-slate-600">{site.about_text}</p></section>}
      <section className="grid gap-4 rounded-2xl bg-slate-50 p-6 text-sm sm:grid-cols-3">
        {site.business_phone && <p className="flex items-center gap-2"><Phone size={16} />{site.business_phone}</p>}
        {site.business_email && <p className="flex items-center gap-2"><Mail size={16} />{site.business_email}</p>}
        {(site.business_city || site.business_state) && <p className="flex items-center gap-2"><MapPin size={16} />{[site.business_city, site.business_state].filter(Boolean).join(', ')}</p>}
      </section>
    </div>
  );
}

function GetInfo({ site, slug }) {
  const requestKey = useMemo(() => crypto.randomUUID(), []);
  const [f, setF] = useState({ first_name: '', last_name: '', email: '', phone: '', state: '', product_interest: '', consent_checked: false, website: '' });
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [err, setErr] = useState('');
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  async function submit(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { await call('submitGetInfo', { ...f, request_key: requestKey, host: window.location.hostname, page_url: window.location.href.split('#')[0].split('?')[0], user_agent: navigator.userAgent }); setDone(true); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  if (done) return <div className="mx-auto max-w-lg rounded-2xl border p-8 text-center"><CheckCircle2 className="mx-auto" size={36} style={{ color: 'var(--brand)' }} /><h1 className="mt-4 text-2xl font-semibold">Thank you</h1><p className="mt-2 text-slate-600">{site.display_name} received your request and will reach out{f.consent_checked ? '' : ' by phone or email'} soon.</p></div>;
  const input = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';
  return (
    <div className="mx-auto max-w-xl">
      <h1 className="text-2xl font-semibold">Request life insurance information</h1>
      <p className="mt-2 text-sm text-slate-600">Tell {site.display_name} a little about what you're looking for. There's no obligation.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">First name<input required className={input} autoComplete="given-name" value={f.first_name} onChange={e => set('first_name', e.target.value)} /></label>
          <label className="text-sm">Last name<input required className={input} autoComplete="family-name" value={f.last_name} onChange={e => set('last_name', e.target.value)} /></label>
        </div>
        <label className="block text-sm">Email<input required type="email" className={input} autoComplete="email" value={f.email} onChange={e => set('email', e.target.value)} /></label>
        <label className="block text-sm">Mobile phone<input required type="tel" className={input} autoComplete="tel" value={f.phone} onChange={e => set('phone', e.target.value)} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm">State<select required className={input} value={f.state} onChange={e => set('state', e.target.value)}><option value="">Choose…</option>{states.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm">Interested in<select required className={input} value={f.product_interest} onChange={e => set('product_interest', e.target.value)}><option value="">Choose…</option>{PRODUCTS.map(p => <option key={p} value={p}>{PRODUCT_LABEL[p]}</option>)}</select></label>
        </div>
        <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" value={f.website} onChange={e => set('website', e.target.value)} />
        <label className="flex items-start gap-3 rounded-lg bg-slate-50 p-4 text-xs leading-5 text-slate-600">
          <input type="checkbox" className="mt-0.5" checked={f.consent_checked} onChange={e => set('consent_checked', e.target.checked)} />
          <span>{site.consent_text.replace(' See our Privacy Policy and Terms.', '')} See our <Link to={`/a/${slug}/privacy`} className="underline">Privacy Policy</Link> and <Link to={`/a/${slug}/sms-terms`} className="underline">SMS Terms</Link>. (Optional)</span>
        </label>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        <button disabled={busy} className="w-full rounded-md px-5 py-3 font-medium text-white disabled:opacity-60" style={{ background: 'var(--brand)' }}>{busy ? 'Sending…' : 'Send my request'}</button>
        <p className="text-center text-[11px] text-slate-500">Texting consent is optional and not required to submit this form or to purchase.</p>
      </form>
    </div>
  );
}

function Doc({ title, children }) {
  return <article className="mx-auto max-w-3xl space-y-4 text-[15px] leading-7 text-slate-700 [&_a]:underline [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_li]:list-disc [&_strong]:text-slate-900 [&_ul]:space-y-1"><h1 className="text-3xl font-bold text-slate-900">{title}</h1><p className="text-sm text-slate-500">Effective {EFFECTIVE}</p>{children}</article>;
}

function Privacy({ site, slug }) {
  const n = site.business_name;
  return (
    <Doc title="Privacy Policy">
      <p>This policy explains how {n} ("we", "us") collects, uses and protects information when you visit this website, request information, or communicate with us by text message, phone or email.</p>
      <h2>Information we collect</h2>
      <p>When you submit our form we collect your name, email address, phone number, state, and the type of coverage you're interested in. We also record whether you agreed to receive text messages, the exact consent wording shown, the date and time, the page you used, and technical details such as your IP address and browser type, so we can document your consent.</p>
      <h2>How we use your information</h2>
      <ul><li>To respond to your request and provide life insurance information and quotes.</li><li>To schedule and confirm phone appointments.</li><li>To send text messages you agreed to receive, as described in our <Link to={`/a/${slug}/sms-terms`}>SMS Terms</Link>.</li><li>To keep records required by law and to honor opt-out requests.</li></ul>
      <h2>Text messaging and mobile information</h2>
      <p><strong>We do not sell, rent or share your mobile phone number or your text messaging opt-in data and consent with third parties or affiliates for their marketing or promotional purposes.</strong> Text messaging originator opt-in data and consent will not be shared with any third parties, except service providers who help us deliver messages to you (such as our messaging platform and phone carriers), who may only use it for that purpose.</p>
      <h2>When we share information</h2>
      <p>If you ask us for a quote or apply for coverage, we share the information needed with the insurance carriers you choose to consider. We also use service providers for hosting, customer relationship management and messaging, who are required to protect your information. We may disclose information when required by law. We do not sell personal information.</p>
      <h2>Your choices</h2>
      <ul><li>Reply <strong>STOP</strong> to any text to stop receiving texts. Reply <strong>HELP</strong> for help.</li><li>To access, correct or delete your information, contact us at {site.business_email || 'the email below'}{site.business_phone ? ` or ${site.business_phone}` : ''}.</li></ul>
      <h2>Security and retention</h2>
      <p>We use reasonable administrative, technical and physical safeguards to protect your information. We keep it only as long as needed for the purposes above and to meet legal and regulatory requirements. Please don't send sensitive health or financial details by text.</p>
      <h2>Children</h2>
      <p>This website is intended for adults 18 and older. We do not knowingly collect information from children.</p>
      <h2>Changes and contact</h2>
      <p>We may update this policy and will post the new version here with a new effective date. Questions? Contact {n}{site.business_address ? `, ${site.business_address}` : ''}{site.business_email ? `, ${site.business_email}` : ''}{site.business_phone ? `, ${site.business_phone}` : ''}.</p>
    </Doc>
  );
}

function Terms({ site, slug }) {
  const n = site.business_name;
  return (
    <Doc title="SMS Terms & Conditions">
      <h2>Program</h2>
      <p><strong>{n} Life Insurance Updates.</strong> {n} sends text messages to people who requested life insurance information and agreed to receive texts. Messages include follow-up on your request, answers to your questions, appointment scheduling, confirmations and reminders.</p>
      <h2>Consent</h2>
      <p>By opting in, you agree to receive text messages from {site.display_name} of {n} at the number you provided, including messages sent using automated technology. <strong>Consent is not a condition of any purchase.</strong></p>
      <h2>Frequency and cost</h2>
      <p>Message frequency varies based on your request and conversation. <strong>Message and data rates may apply.</strong> Check your mobile plan for details.</p>
      <h2>Opt out and help</h2>
      <p>Reply <strong>STOP</strong> at any time to cancel. You'll receive one final message confirming you've been unsubscribed, and no more messages will be sent. Reply <strong>HELP</strong> for help, or contact us at {site.business_phone || site.business_email}{site.business_phone && site.business_email ? ` or ${site.business_email}` : ''}.</p>
      <h2>Carriers</h2>
      <p>Supported on major US carriers. Carriers are not liable for delayed or undelivered messages.</p>
      <h2>Eligibility</h2>
      <p>You must be 18 or older and the account holder or authorized user of the mobile number you provide.</p>
      <h2>Privacy</h2>
      <p>See our <Link to={`/a/${slug}/privacy`}>Privacy Policy</Link>. We do not share your mobile number or opt-in consent with third parties for marketing purposes.</p>
      <h2>Contact</h2>
      <p>{n}{site.business_address ? `, ${site.business_address}` : ''}{site.business_email ? ` · ${site.business_email}` : ''}{site.business_phone ? ` · ${site.business_phone}` : ''}</p>
    </Doc>
  );
}

/** The agent's LeadConnector chat bubble, when they've added one. Only a validated widget ID is used. */
function ChatWidget({ id }) {
  useEffect(() => {
    if (!/^[a-f0-9]{24}$/.test(id || '') || document.querySelector(`script[data-widget-id="${id}"]`)) return undefined;
    const el = document.createElement('script');
    el.src = 'https://widgets.leadconnectorhq.com/loader.js';
    el.async = true;
    el.dataset.resourcesUrl = 'https://widgets.leadconnectorhq.com/chat-widget/loader.js';
    el.dataset.widgetId = id;
    el.dataset.source = 'WEB_USER';
    document.body.appendChild(el);
    return undefined;
  }, [id]);
  return null;
}

export default function AgentSite() {
  const { slug = '', '*': rest = '' } = useParams();
  const { data: site, isLoading, error } = useSite(slug);
  if (isLoading) return <div className="flex min-h-screen items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-700" /></div>;
  if (error || !site) return <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center"><ShieldCheck size={28} className="text-slate-400" /><h1 className="text-xl font-semibold">Page not found</h1><p className="text-sm text-slate-500">This agent page doesn't exist or is no longer active.</p></div>;
  const page = rest.replace(/\/$/, '');
  if (typeof document !== 'undefined') document.title = `${site.brand_name || site.business_name}${page === 'privacy' ? ' – Privacy Policy' : page === 'sms-terms' ? ' – SMS Terms' : page === 'get-info' ? ' – Request Information' : ''}`;
  return (
    <Shell site={site} slug={slug}>
      <ChatWidget id={site.chat_widget_id} />
      {page === 'get-info' ? <GetInfo site={site} slug={slug} /> : page === 'privacy' ? <Privacy site={site} slug={slug} /> : page === 'sms-terms' ? <Terms site={site} slug={slug} /> : <Home site={site} slug={slug} />}
    </Shell>
  );
}
