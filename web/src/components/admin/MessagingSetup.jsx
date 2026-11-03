import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';
export default function MessagingSetup({form,run,busy}) {
 const [confirmed,setConfirmed]=useState(false),[copying,setCopying]=useState(false),[fallback,setFallback]=useState('');
 async function copy(){
  setCopying(true);setFallback('');
  let url='';
  try{const result=await call('adminMessaging',{agent_email:form.agent_email,action:'webhook'});url=result.url;await navigator.clipboard.writeText(url);notify.ok('Webhook address copied','Paste it into the GHL webhook settings. Keep it private.');}
  catch(e){if(url){setFallback(url);notify.info("Couldn't copy automatically",'Select and copy the address shown below.');}else notify.err(e,'Webhook address not loaded');}
  finally{setCopying(false);}
 }
 const k=a=>busy===`adminMessaging:${a}`;
 return <div className="space-y-4 rounded-lg border p-4"><h3 className="text-sm font-semibold">Messaging activation</h3><p className="text-xs leading-6 text-muted-foreground">Status: {form.status||'onboarding'} · Account mode: {form.mode==='autopilot'?'Autopilot':'Review'} · Webhook: {form.onboarding_checks?.webhook_received?'received':'not received'}</p><Button variant="outline" type="button" loading={copying} disabled={!!busy} onClick={copy}>Copy private webhook address</Button>{fallback&&<input readOnly className="field lr-rise font-mono text-xs" value={fallback} onFocus={e=>e.target.select()}/>}<p className="text-xs leading-6 text-muted-foreground">Configure InboundMessage, OutboundMessage, AppointmentCreate, AppointmentUpdate and AppointmentDelete events with their documented payloads. A valid event confirms the connection automatically.</p><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I confirm this account’s live messaging checks and understand that Autopilot sends without individual approvals.</label><div className="flex flex-wrap gap-2"><Button variant="outline" loading={k('agent_mode:review')} disabled={!!busy} onClick={()=>run('adminMessaging',{action:'agent_mode',mode:'review'})}>Use Review</Button><Button variant="outline" loading={k('agent_mode:autopilot')} disabled={!!busy||!confirmed} onClick={()=>run('adminMessaging',{action:'agent_mode',mode:'autopilot',confirmed:true})}>Enable Autopilot</Button><Button loading={k('go_live')} disabled={!!busy||!confirmed} onClick={()=>run('adminMessaging',{action:'go_live',confirmed:true})}>Activate account</Button><Button variant="outline" loading={k('pause')} disabled={!!busy} onClick={()=>run('adminMessaging',{action:'pause'})}>Pause account</Button></div></div>;
}