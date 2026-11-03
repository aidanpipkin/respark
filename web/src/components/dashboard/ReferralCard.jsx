import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Check, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

const usd = c => `$${Math.round((Number(c) || 0) / 100)}`;

/** Records a pending invite once the new agent is signed in. Renders nothing. */
export function ReferralClaimer() {
  useEffect(() => {
    let code = '';
    try { code = localStorage.getItem('lr-ref') || ''; } catch { return; }
    if (!code) return;
    call('referral', { action: 'claim', code })
      .then(r => { if (r?.claimed) notify.ok('Invite applied', `You joined through ${r.referrer}. Your free texts land when you start your subscription.`); })
      .catch(() => {}).finally(() => { try { localStorage.removeItem('lr-ref'); } catch { /* storage blocked */ } });
  }, []);
  return null;
}

/** "Invite an agent": a shareable link, with both sides earning text credits. */
export default function ReferralCard() {
  const { data } = useQuery({ queryKey: ['referral'], queryFn: () => call('referral', { action: 'status' }), staleTime: 300000 });
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const msg = `I've been using LeadRespark to bring my old life insurance leads back to life. The AI texts them and books calls on my calendar. Sign up with my link and you get ${usd(data.referee_reward_cents)} in free texts: ${data.link}`;
  async function copy() {
    try { await navigator.clipboard.writeText(data.link); setCopied(true); setTimeout(() => setCopied(false), 1800); notify.ok('Link copied', 'Paste it in a text or email to another agent.'); }
    catch { notify.err(`Couldn't copy. Here's your link: ${data.link}`); }
  }
  return (
    <section className="panel flex flex-wrap items-center gap-x-6 gap-y-3 p-4 sm:p-5">
      <div className="min-w-0 flex-1">
        <h2 className="section-title">Invite an agent: you get {usd(data.referrer_reward_cents)}, they get {usd(data.referee_reward_cents)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Credits land when they start their subscription with your link.{data.joined ? ` ${data.joined} joined so far${data.earned_cents ? `, ${usd(data.earned_cents)} earned` : ''}.` : ''}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={copy} className={copied ? 'lr-done' : ''}>{copied ? <Check className="lr-pop text-success" /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button>
        <Button variant="outline" asChild className="sm:hidden"><a href={`sms:?&body=${encodeURIComponent(msg)}`}><MessageSquare />Text it</a></Button>
      </div>
    </section>
  );
}
