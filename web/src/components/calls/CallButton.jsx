import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Phone, PhoneOff, Loader2, Smartphone, Check, MessageSquare, NotebookPen, CalendarPlus, Hash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { call as api } from '@/components/workspace/api';
import { stageColors, stageOf, stageLabel } from '@/lib/stages';
import { notify } from '@/lib/feedback';

const LIVE = ['calling_agent', 'briefing', 'ringing_lead', 'in_progress'];
const mmss = s => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
const initials = name => String(name || '').split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const ago = iso => { if (!iso) return ''; const d = Math.round((Date.now() - Date.parse(iso)) / 60000); return d < 60 ? `${d}m ago` : d < 1440 ? `${Math.round(d / 60)}h ago` : `${Math.round(d / 1440)}d ago`; };

// What the agent is waiting on, in one line, for each stage of the call.
const PHASE = {
  calling_agent: ['Ringing your phone', 'Pick up to continue.'],
  briefing: ['On your phone now', 'Press any key when you are ready and we dial the lead.'],
  ringing_lead: ['Calling the lead', 'They see your business number.'],
  in_progress: ['Connected', ''],
};

function Pulse({ phase, children }) {
  const c = stageColors(phase === 'in_progress' ? 'booked' : 'texting');
  return <div className="relative mx-auto flex h-24 w-24 items-center justify-center">
    {phase !== 'in_progress' && <><span className="lr-ring absolute inset-0 rounded-full" style={{ background: c.soft }} /><span className="lr-ring absolute inset-0 rounded-full" style={{ background: c.soft, animationDelay: '0.6s' }} /></>}
    <span className="relative flex h-20 w-20 items-center justify-center rounded-full text-2xl font-semibold" style={{ background: c.soft, color: c.ink }}>{children}</span>
  </div>;
}

export default function CallButton({ leadId, variant = 'outline', size = 'sm', className = '', label = 'Call', iconOnly = false }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false), [info, setInfo] = useState(null), [cell, setCell] = useState(''), [remember, setRemember] = useState(true);
  const [current, setCurrent] = useState(null), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [tick, setTick] = useState(0), [ending, setEnding] = useState(false);
  const poll = useRef(null);

  async function begin() {
    setOpen(true); setErr(''); setCurrent(null); setInfo(null); setEnding(false);
    try { setInfo(await api('calls', { action: 'prepare', lead_id: leadId })); } catch (e) { setErr(e.message); }
  }
  async function start() {
    setBusy('start'); setErr(''); setEnding(false);
    try { const r = await api('calls', { action: 'start', lead_id: leadId, ...(info?.cell ? {} : { agent_phone: cell, remember_cell: remember }) }); setCurrent(r.call); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function hangup() {
    if (!current) return;
    setBusy('hangup');
    try { await api('calls', { action: 'hangup', id: current.id }); setEnding(true); } catch { /* status poll catches up */ } finally { setBusy(''); }
  }
  function finish() {
    setOpen(false);
    if (current?.status === 'completed') notify.ok('Call ended', `${mmss(current.duration_sec || talkSec)} with ${info?.lead?.first_name || 'the lead'}. Notes keep the AI on track.`, { label: 'Add notes', to: `/contacts/${leadId}` });
  }

  useEffect(() => {
    if (!current?.id || !LIVE.includes(current.status)) { clearInterval(poll.current); if (current && !LIVE.includes(current.status)) { qc.invalidateQueries({ queryKey: ['thread'] }); qc.invalidateQueries({ queryKey: ['conversations'] }); } return; }
    poll.current = setInterval(async () => { try { const r = await api('calls', { action: 'status', id: current.id }); setCurrent(r.call); } catch { /* keep polling */ } }, 1000);
    return () => clearInterval(poll.current);
  }, [current?.id, current?.status]);
  useEffect(() => { if (current?.status !== 'in_progress') return; const t = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(t); }, [current?.status]);

  const live = current && LIVE.includes(current.status);
  const talkSec = current?.answered_at ? Math.floor((Date.now() - Date.parse(current.answered_at)) / 1000) : 0;
  const ended = current && !live;
  const lead = info?.lead;
  const endText = !ended ? '' : current.status === 'completed' ? `Call ended, ${mmss(current.duration_sec || talkSec)}` : current.status === 'agent_missed' ? (current.note || "You didn't pick up, so we didn't dial the lead.") : current.status === 'busy' ? 'The line was busy.' : current.status === 'failed' ? (current.note || 'The call could not be placed.') : 'No answer. A text usually gets a reply within the hour.';
  const [phaseTitle, phaseHint] = PHASE[current?.status] || ['', ''];
  void tick;

  return <>
    <Button type="button" variant={variant} size={size} className={`gap-1.5 ${className}`} onClick={begin} aria-label={`Call ${label === 'Call' ? 'this lead' : label}`}><Phone size={14} />{!iconOnly && label}</Button>
    <Dialog open={open} onOpenChange={v => { if (!v && live) return; setOpen(v); }}>
      <DialogContent className="max-w-sm overflow-hidden p-0">
        <DialogTitle className="sr-only">{info ? `Call ${info.lead_name}` : 'Call'}</DialogTitle>
        <DialogDescription className="sr-only">Click to call: we ring your phone first, then connect the lead from your business number.</DialogDescription>

        {!info && !err && <div className="flex justify-center py-14"><Loader2 className="animate-spin text-muted-foreground" /></div>}

        {info && <div className="space-y-5 px-6 pb-6 pt-7 text-center">
          <Pulse phase={current?.status || 'idle'}>{live ? initials(info.lead_name) : current?.status === 'completed' ? <Check size={30} strokeWidth={3} /> : initials(info.lead_name)}</Pulse>

          <div>
            <p className="text-lg font-semibold leading-tight">{info.lead_name}</p>
            <p className="mt-1 text-sm text-muted-foreground">{info.lead_phone}{lead?.state ? ` · ${lead.state}` : ''}{lead?.local_time ? ` · ${lead.local_time} their time` : ''}</p>
          </div>

          {/* Before the call: who this is, in three lines, so the agent walks in warm. */}
          {!current && <>
            {lead && <div className="rounded-xl bg-muted/50 p-3 text-left text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md px-2 py-0.5 text-xs font-medium" style={{ background: stageColors(stageOf(lead.status)).soft, color: stageColors(stageOf(lead.status)).ink }}>{stageLabel(stageOf(lead.status))}</span>
                {lead.interest && <span className="text-xs text-muted-foreground">{lead.interest}</span>}
                {lead.last_inbound_at && <span className="text-xs text-muted-foreground">Replied {ago(lead.last_inbound_at)}</span>}
                {lead.last_call && <span className="text-xs text-muted-foreground">Last call {ago(lead.last_call.started_at)}{lead.last_call.status === 'completed' ? ` (${mmss(lead.last_call.duration_sec || 0)})` : lead.last_call.status === 'voicemail' ? ' (voicemail)' : ' (no answer)'}</span>}
              </div>
              {lead.summary && <p className="mt-2 leading-5 text-muted-foreground">{lead.summary}</p>}
            </div>}
            {info.blocked ? <p className="rounded-xl p-3 text-sm" style={{ background: stageColors('needs_you').soft, color: stageColors('needs_you').ink }}>{info.blocked}</p> : <>
              {info.cell ? <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Smartphone size={14} />Rings {info.cell_pretty} first, then dials {lead?.first_name || 'them'} from {info.from_pretty}</p>
                : <div className="space-y-2 text-left"><label className="text-xs font-medium" htmlFor="agent-cell">Your cell number</label><input id="agent-cell" className="field" inputMode="tel" placeholder="(555) 555-5555" value={cell} onChange={e => setCell(e.target.value)} /><label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />Remember it for next time</label></div>}
              <Button size="lg" className="h-14 w-full gap-2 text-base" loading={busy === 'start'} disabled={!info.cell && cell.replace(/\D/g, '').length < 10} onClick={start}>{busy !== 'start' && <Phone size={18} />}{busy === 'start' ? 'Starting' : `Call ${lead?.first_name || 'now'}`}</Button>
            </>}
          </>}

          {/* During the call: one clear status, a big timer once connected, one way out. */}
          {live && <div className="space-y-4 lr-rise">
            <div>
              <p className="text-base font-semibold">{phaseTitle}</p>
              {current.status === 'in_progress' ? <p className="mt-1 text-4xl font-semibold tabular-nums">{mmss(talkSec)}</p> : <p className="mt-1 text-sm text-muted-foreground">{phaseHint}</p>}
              {current.status === 'briefing' && <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"><Hash size={12} />Any key on your phone connects the call</p>}
            </div>
            <Button variant="destructive" size="lg" className="h-14 w-full gap-2 text-base" loading={busy === 'hangup' || ending} onClick={hangup}>{busy !== 'hangup' && !ending && <PhoneOff size={18} />}{busy === 'hangup' || ending ? 'Hanging up' : 'Hang up'}</Button>
          </div>}

          {/* After: the result and the three things an agent does next. */}
          {ended && <div className="space-y-4 lr-rise">
            <p className="text-sm">{endText}</p>
            <div className="grid grid-cols-3 gap-2">
              <Button asChild variant="outline" className="h-auto flex-col gap-1 py-3 text-xs"><Link to={`/contacts/${leadId}`} onClick={() => setOpen(false)}><NotebookPen size={16} />Add note</Link></Button>
              <Button asChild variant="outline" className="h-auto flex-col gap-1 py-3 text-xs"><Link to={`/inbox?lead=${leadId}`} onClick={() => setOpen(false)}><MessageSquare size={16} />Text them</Link></Button>
              <Button asChild variant="outline" className="h-auto flex-col gap-1 py-3 text-xs"><Link to={`/appointments?book=${leadId}`} onClick={() => setOpen(false)}><CalendarPlus size={16} />Book a call</Link></Button>
            </div>
            <div className="flex gap-2"><Button variant="ghost" className="flex-1" onClick={() => { setCurrent(null); }}>Call again</Button><Button className="flex-1" onClick={finish}>Done</Button></div>
          </div>}

          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>}
        {!info && err && <p className="px-6 pb-6 text-sm text-destructive">{err}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
