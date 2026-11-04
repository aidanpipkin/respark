import { adminContext } from '../_shared/agentAccess.ts';
import { heartbeat } from '../_shared/signals.ts';
import { agentSettings,ghl,failure } from '../_shared/ghl.ts';
import { sendSms } from '../_shared/messageSender.ts';
import { recordDelivery } from '../_shared/messageDelivery.ts';
import { labelSlot,clockOpen } from '../_shared/messageClock.ts';
import { logMessage } from '../_shared/messageJobs.ts';
import { loadCursor,saveCursor } from '../_shared/sweepCursor.ts';
import { waitUntil } from '../_shared/runtime.ts';
import { runJourney } from '../_shared/appointmentJourney.ts';
import { appOrigin } from '../_shared/agentSite.ts';
export default async function(req){try{const {base44}=await adminContext(req),input=await req.json(),E=base44.asServiceRole.entities,now=Date.now(),deadline=Date.now()+90000;let cursor=undefined,sent=0,skipped=0;if(input.dry_run===true)return Response.json({ok:true});
 // Booked-call journey: confirmations, reminders, agent briefs and morning agendas.
 const journey=await runJourney(base44,appOrigin(req),deadline-30000);sent=journey.sent;skipped=journey.skipped;
 const pending=await E.MessageDispatch.filter({kind:'sms',state:'done',ghl_message_id:{$exists:true},delivery_status:{$nin:['delivered','read','failed','undelivered']},created_date:{$gte:new Date(now-48*3600000).toISOString()}},{sort:'created_date',limit:25});for(let i=0;i<pending.items.length;i+=4)await Promise.allSettled(pending.items.slice(i,i+4).map(async dispatch=>{if(/^SM[0-9a-f]{32}$/i.test(String(dispatch.ghl_message_id||'')))return;/* Twilio receipts arrive by webhook */const s=await agentSettings(base44,dispatch.agent_email);if(!s?.connected)return;const data=await ghl(s,`/conversations/messages/${encodeURIComponent(dispatch.ghl_message_id)}`);const status=data.message?.status||data.status;if(status)await recordDelivery(base44,s,dispatch.ghl_message_id,status);}));await heartbeat(base44,'appointment_reminders',{sent,skipped});return Response.json({sent,skipped,journey});}catch(error){return failure(error);}}