import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Copy, ExternalLink, Globe, Check } from 'lucide-react';
import { notify } from '@/lib/feedback';

export default function AgentSiteCard({ site }) {
  const [copied, setCopied] = useState('');
  if (!site) return null;
  const rows = [['Your page', site.url], ['Request-info form', site.get_info_url], ['Privacy policy', site.privacy_url], ['SMS terms', site.terms_url]];
  async function copy(v) { try { await navigator.clipboard.writeText(v); setCopied(v); setTimeout(() => setCopied(''), 1500); } catch { notify.err('Your browser blocked copying. Press and hold the link to copy it instead.', 'Link not copied'); } }
  return (
    <section className="panel space-y-4 p-5">
      <div className="flex items-start gap-3">
        <Globe size={18} className="mt-0.5" />
        <div>
          <h2 className="font-semibold">Your compliant web page</h2>
          <p className="subtext mt-1">Carriers require a public page showing how people opt in to texts, plus a privacy policy and SMS terms. We host these for you, built from your profile. Share the form link anywhere you collect leads.</p>
        </div>
      </div>
      <ul className="divide-y text-sm">{rows.map(([label, url]) => <li key={label} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className="text-muted-foreground">{label}</span><span className="flex items-center gap-1"><a href={url} target="_blank" rel="noreferrer" className="max-w-[60vw] truncate text-primary underline sm:max-w-xs">{url.replace(/^https:\/\//, '')}</a><Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => copy(url)} aria-label={`Copy ${label}`}>{copied === url ? <span className="flex items-center gap-1 text-success lr-pop"><Check size={14} />Copied</span> : <Copy size={14} />}</Button><a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}><ExternalLink size={14} /></a></span></li>)}</ul>
      <p className="text-[11px] text-muted-foreground">Business name, address, phone and email come from your Profile. Update them there and these pages update automatically.</p>
    </section>
  );
}
