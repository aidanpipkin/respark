import { useState } from 'react';
import { Phone, PhoneIncoming, PhoneMissed, Voicemail, Play, Loader2 } from 'lucide-react';
import { call as api } from '@/components/workspace/api';
import { stageColors } from '@/lib/stages';

const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** A call or voicemail in the conversation timeline. */
export default function CallBubble({ m }) {
  const c = m.call || {}; const out = m.direction === 'outbound';
  const [audio, setAudio] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const vm = c.status === 'voicemail';
  const missed = ['missed', 'no_answer', 'busy', 'agent_missed', 'failed'].includes(c.status);
  const Icon = vm ? Voicemail : missed ? PhoneMissed : out ? Phone : PhoneIncoming;
  const tone = vm || (missed && !out) ? 'needs_you' : missed ? 'closed' : 'booked';
  const col = stageColors(tone);
  const text = vm ? `Voicemail · ${mmss(c.voicemail_sec || 0)}`
    : c.status === 'completed' ? `${out ? 'You called' : 'They called'} · ${mmss(c.duration_sec || 0)}`
      : c.status === 'agent_missed' ? 'Call not placed: you didn’t pick up'
        : c.status === 'missed' ? 'Missed call'
          : ['calling_agent', 'ringing_lead', 'in_progress', 'ringing_agent'].includes(c.status) ? 'Call in progress…'
            : out ? `You called · ${c.status === 'busy' ? 'busy' : 'no answer'}` : 'Missed call';
  async function play() { setBusy(true); setErr(''); try { const r = await api('calls', { action: 'recording', id: c.id }); setAudio(r.data_url); } catch (e) { setErr(e.message); } finally { setBusy(false); } }
  return <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
    <div className="max-w-[86%] rounded-2xl border px-3 py-2 sm:max-w-[74%]" style={{ background: col.faint || col.soft, borderColor: col.line || 'transparent' }}>
      <p className="flex items-center gap-2 text-[12px] font-medium" style={{ color: col.ink }}><Icon size={14} />{text}<span className="ml-2 text-[9px] font-normal opacity-60">{new Date(m.dateAdded).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span></p>
      {vm && (audio ? <audio controls autoPlay src={audio} className="mt-2 h-9 w-64 max-w-full" /> : <button onClick={play} disabled={busy} className="mt-1.5 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: col.ink }}>{busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}Play voicemail</button>)}
      {err && <p className="mt-1 text-[10px] text-destructive">{err}</p>}
    </div>
  </div>;
}
