import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Send, RotateCcw, Info } from 'lucide-react';
import { call } from '@/components/workspace/api';

const CHIPS = ['Who is this?', 'Yeah I remember', 'How much does it cost?', "I'm always on the road", 'IULs are a scam', 'Not right now', 'STOP'];

export function openerFor(agent, agency) {
  return `Hey Marcus, it's ${agent} with ${agency}. Back in February you asked about life insurance to protect Tasha and the girls while you're out on the road. Is that still on your mind? Reply STOP to opt out.`;
}

/** Phone-style practice chat. The person plays "Marcus", a sample lead; the real AI answers. */
export default function ChatDemo({ endpoint, agent, agency, className = '', autoFocus = false }) {
  const start = () => [{ role: 'ai', text: openerFor(agent, agency) }];
  const [msgs, setMsgs] = useState(start), [text, setText] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const box = useRef(null);
  useEffect(() => { const el = box.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);

  async function send(value) {
    const t = String(value ?? text).trim();
    if (!t || busy) return;
    const before = msgs;
    setText(''); setErr(''); setMsgs([...before, { role: 'lead', text: t }]); setBusy(true);
    try {
      const r = await call(endpoint, { message: t, history: before.filter(m => m.role !== 'note') });
      setMsgs(m => [...m, ...(r.reply ? [{ role: 'ai', text: r.reply }] : []), ...(r.note ? [{ role: 'note', text: r.note }] : [])]);
    } catch (e) { setErr(e.message); setMsgs(before); setText(t); }
    finally { setBusy(false); }
  }

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <div ref={box} className="min-h-[300px] flex-1 space-y-2 overflow-y-auto bg-canvas px-4 py-5">
        {msgs.map((m, i) => m.role === 'note'
          ? <p key={i} className="mx-auto flex max-w-[94%] gap-2 rounded-lg border bg-card px-3 py-2 text-xs leading-5 text-muted-foreground lr-fade-in"><Info size={13} className="mt-0.5 shrink-0 text-primary" />{m.text}</p>
          : <div key={i} className={`flex lr-fade-in ${m.role === 'lead' ? 'justify-end' : 'justify-start'}`}>
              <p className={`max-w-[84%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${m.role === 'lead' ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md border bg-card text-foreground'}`}>{m.text}</p>
            </div>)}
        {busy && <div className="flex justify-start"><span className="flex gap-1 rounded-2xl rounded-bl-md border bg-card px-4 py-3">{[0, 1, 2].map(d => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: `${d * 120}ms` }} />)}</span></div>}
      </div>
      <div className="space-y-3 border-t bg-card p-3">
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {CHIPS.map(c => <button key={c} type="button" disabled={busy} onClick={() => send(c)} className="h-8 shrink-0 rounded-full border bg-background px-3 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-50">{c}</button>)}
        </div>
        <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); send(); }}>
          <button type="button" title="Start over" aria-label="Start over" onClick={() => { setMsgs(start()); setErr(''); }} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-muted-foreground hover:text-foreground"><RotateCcw size={15} /></button>
          <input className="field h-10 flex-1 rounded-full" placeholder="Reply as Marcus…" value={text} maxLength={400} onChange={e => setText(e.target.value)} autoFocus={autoFocus} />
          <Button type="submit" size="icon" className="h-10 w-10 shrink-0 rounded-full" disabled={busy || !text.trim()} aria-label="Send"><Send size={15} /></Button>
        </form>
        {err && <p role="alert" className="text-xs text-destructive">{err}</p>}
      </div>
    </div>
  );
}
