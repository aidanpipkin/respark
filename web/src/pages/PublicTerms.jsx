import { Link } from 'react-router-dom';

const sections = [
  ['Agent use', 'Respark is a CRM and automation platform for insurance agents and agencies. It is not an insurer, an insurance quote service, or a client-facing insurance application portal.'],
  ['Your account', 'Use accurate business information, protect your login credentials, and use the workspace only for business activities you are authorized to carry out. Workspace administrators manage access and setup.'],
  ['Contacts and messaging', 'You are responsible for the source, accuracy, and lawful use of contact information. Obtain and retain required consent, honor opt-outs, and comply with applicable messaging, privacy, and insurance requirements. Texting registration and approval may be required before messaging can begin.'],
  ['Automation and AI', 'Review campaign content, suggested replies, settings, and appointment details before relying on them. AI output can be inaccurate. Automation does not replace professional judgment, licensing obligations, or your responsibility for communications sent from your workspace.'],
  ['Connected services and charges', 'Calendar, messaging, billing, and other connected features depend on third-party services. Availability and delivery are not guaranteed. Review and authorize applicable charges before enabling paid services.'],
  ['Subscription and credits', 'LeadRespark is billed as a monthly subscription, charged to the card you save when you start it and renewed each month until you cancel. Texts, calls and additional phone numbers are paid from prepaid credits at the prices shown in your workspace before you buy. If you turn on auto-recharge, your card is charged the amount you chose whenever your balance falls below the threshold you chose. You can turn auto-recharge off, change your card, or cancel your subscription from Billing & credits at any time; a cancellation takes effect at the end of the current billing period.'],
  ['Acceptable use', 'Do not use Respark for spam, misleading communications, unauthorized access, or unlawful activity. Do not attempt to access another agent’s records or bypass consent and safety controls.'],
  ['Results', 'Respark helps organize work and follow-up. It does not guarantee replies, appointments, policy sales, revenue, or carrier approval.'],
  ['Questions', 'Signed-in agents can reach us from Get help inside the workspace. If someone else gave you access, you can also contact them.'],
];

export default function PublicTerms() {
  return <main className="mx-auto max-w-3xl px-6 py-14">
    <h1 className="page-title">Platform Terms</h1>
    <p className="mt-3 text-sm text-muted-foreground">Last updated: October 16, 2026</p>
    <div className="mt-10 space-y-8">{sections.map(([title, text]) => <section key={title}><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 text-sm leading-7 text-muted-foreground">{text}</p></section>)}</div>
    <Link to="/privacy" className="mt-8 inline-block py-3 text-sm underline underline-offset-4">Privacy Policy</Link>
  </main>;
}