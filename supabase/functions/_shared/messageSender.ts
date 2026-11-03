import { smsClean } from './smsText.ts';
import { isInfraError } from './entityRetry.ts';
import { ghl,agentSettings } from './ghl.ts';
import { isRehearsal,isTestLead } from './rehearsal.ts';
import { checkSafety,basicSafety } from './messageSafety.ts';
import { claimJob,finishJob,flagHuman,logMessage,updateSummary } from './messageJobs.ts';
import { guardrailCheck } from './guardrails.ts';
import { reserveText,debitText,refundText } from './credits.ts';
import { sendText } from './smsTransport.ts';
import { afterSend } from './followUpSchedule.ts';
import { serviceCheck } from './tracks.ts';
export async function lockLead(base44,lead){const E=base44.asServiceRole.entities,token=crypto.randomUUID(),now=new Date().toISOString();await E.Lead.updateMany({id:lead.id,updated_date:lead.updated_date,$or:[{send_lock_until:{$exists:false}},{send_lock_until:''}, { send_lock_until: null },{send_lock_until:{$lte:now}}]},{$set:{send_lock_token:token,send_lock_until:new Date(Date.now()+120000).toISOString()}});const fresh=await E.Lead.get(lead.id);if(fresh.send_lock_token!==token){const b=new Error('This conversation changed or another message is processing. Refresh and try again.');b.name='Busy';throw b;}return fresh;}
export async function unlockLead(base44,lead){await base44.asServiceRole.entities.Lead.updateMany({id:lead.id,send_lock_token:lead.send_lock_token},{$set:{send_lock_token:'',send_lock_until:''}});}
/**
 * Sends one text to a lead. `options` may carry objects the caller already holds so they are not read again:
 *   lead, settings (AgentSettings), campaign, billing ({config, account} from credits.billingContext).
 * One fresh Lead read always happens inside lockLead (the lock/CAS); that one is correctness.
 */
export async function sendSms(base44,leadId,text,source,key,options:any={}){text=smsClean(String(text||''));
 if(typeof text!=='string'||!text.trim()||text.length>(source==='manual'?1600:source==='service'?480:300))throw new Error('Enter a message within the character limit.');text=text.trim();if(source==='service'?!serviceCheck(text).passed:(source!=='manual'&&!guardrailCheck(text).passed))throw new Error('This message requires rewriting to pass the safety checks.');
 const E=base44.asServiceRole.entities;let lead=(options.lead&&options.lead.id===leadId)?options.lead:await E.Lead.get(leadId);let s=(options.settings&&options.settings.agent_email===lead.agent_email)?options.settings:await agentSettings(base44,lead.agent_email,options.automatic===true);basicSafety(s,lead,source);if(source==='booking'&&lead.status!=='booked')throw new Error('The appointment must be confirmed first.');
 if(['sequence','nudge','nurture','track'].includes(source)){const count=await E.MessageLog.count({agent_email:s.agent_email,lead_id:lead.id,event_type:'sms_sent',occurred_at:{$gte:new Date(Date.now()-86400000).toISOString()}});if(count>=3)throw new Error('Daily contact message limit reached.');}
 // Credits are checked before anything is claimed, so an empty wallet pauses the text cleanly instead of flagging it for review.
 // Fictional test leads are never charged (same as the rehearsal agent).
 const fictional=isTestLead(lead);const reserved=fictional?null:await reserveText(E,s.agent_email,text,options.billing||{});let carrierAccepted=false,refunded=false;
 const giveBack=async()=>{if(refunded||carrierAccepted)return;refunded=true;await refundText(E,reserved).catch(()=>{});};
 try{lead=await lockLead(base44,lead);}catch(error){await giveBack();throw error;}let job,attempted=false;
 try{const claimed=await claimJob(base44,s,key,'sms',lead.id);if(!claimed.claimed){await giveBack();if(claimed.job.state==='done')return claimed.job.result;
  // Another run holds this job (or it was abandoned). The dispatcher's reaper frees stuck jobs; retry on the next tick instead of flagging the lead.
  if(claimed.job.state==='working'){const t=new Error('This text is already being delivered; it will not be sent twice. Automatic sends retry on the next run.');t.name='Transient';throw t;}
  throw new Error('Delivery is processing or needs administrator review; it will not be sent twice.');}job=claimed.job;await E.MessageDispatch.update(job.id,{body:text,step_number:options.step_number||0,delivery_status:'pending'});
 ({s}=await checkSafety(base44,lead,source,true,options.automatic===true,{settings:s,campaign:options.campaign}));if(source==='booking'&&lead.status!=='booked')throw new Error('The confirmed appointment changed.');if(options.trigger_at&&(lead.last_inbound_at!==options.trigger_at||(options.inbound_message_id&&lead.last_inbound_id&&lead.last_inbound_id!==options.inbound_message_id)))throw new Error('A newer reply arrived. Refresh the suggested reply.');
 if(source==='reminder'){const appointment=await E.Appointment.get(options.appointment_id);if(appointment.status!=='booked'||appointment.lead_id!==lead.id||appointment.start_time!==options.start_time||lead.status!=='booked')throw new Error('The appointment changed. No reminder was sent.');}
 // Delivery receipts: step 1 of a sequence needs one (step1_delivered gates the rest); later steps do not.
 const statusCallback=!(source==='sequence'&&Number(options.step_number||0)>=2);
 attempted=true;const result=await sendText(E,s,lead,text,{statusCallback});if(!result.messageId)throw new Error('Delivery acknowledgement missing.');carrierAccepted=true;const at=new Date().toISOString();
 const simulated=isRehearsal(s)||fictional;await E.MessageDispatch.update(job.id,{ghl_message_id:result.messageId,from_number:result.from||'',...(simulated?{delivery_status:'delivered'}:{})});await logMessage(base44,s,lead,{event_type:'sms_sent',direction:'outbound',source,body:text,status:'accepted',ghl_message_id:result.messageId,step_number:options.step_number||0,dispatch_id:job.id,number:result.from||''});
 const patch={last_outbound_at:at,ghl_conversation_id:result.conversationId||lead.ghl_conversation_id||'',...afterSend(lead,source),...(options.offered_slots?.length?{offered_slots:options.offered_slots,offered_at:at}:{}),...(fictional&&Number(options.step_number||0)===1?{step1_delivered:true}:{})};
 await E.Lead.updateMany({id:lead.id,send_lock_token:lead.send_lock_token},{$set:patch});
 const current={...lead,...patch};await updateSummary(base44,s,current,text,'outbound',at,{has_pending_draft:false});const response={sent:true,message_id:result.messageId};await finishJob(base44,job,response);try{await debitText(E,s.agent_email,reserved,{lead_id:lead.id,dispatch_id:job.id});}catch{/* the text went out; a ledger hiccup must not mark it failed */}return response;
 }catch(error){await giveBack();if(error?.name==='Transient')throw error;if(job&&!attempted){await E.MessageDispatch.update(job.id,{state:'new',token:''}).catch(()=>{});if(isInfraError(error)){const t=new Error('Platform busy; this text will retry on the next run.');t.name='Transient';throw t;}throw error;}if(job){await finishJob(base44,job,{error:'Delivery needs review before any retry.'},'uncertain');await flagHuman(base44,s,lead,'Delivery could not be confirmed. Review the conversation before retrying.');}throw error;}finally{await unlockLead(base44,lead);}
}