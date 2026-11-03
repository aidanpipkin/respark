import { context, agentSettings } from './ghl.ts';
export async function setupContext(req) {
 const {base44,user}=await context(req); const s=await agentSettings(base44,user.email);
 if(!s) throw new Error('Your administrator must create your agent profile first.');
 return {base44,user,s,E:base44.asServiceRole.entities};
}
export async function configFor(E){const p=await E.PlatformSettings.filter({singleton_key:'platform'},{limit:1});if(!p.items[0])throw new Error('Platform settings are not configured.');return p.items[0];}
// New self-serve accounts start with no checklist object, so merge into a fresh copy instead of a dotted $set.
export async function checklist(E,s,key,value){const fresh=await E.AgentSettings.get(s.id).catch(()=>s);const current=(fresh?.setup_checklist&&typeof fresh.setup_checklist==='object')?fresh.setup_checklist:{};await E.AgentSettings.update(s.id,{setup_checklist:{...current,[key]:value}});}
export async function setupLog(E,s,kind,summary,status=200){await E.ProvisioningLog.create({agent_email:s.agent_email,location_id:s.location_id||'',step:'self_serve',object_type:kind,request_summary:summary,response_status:status,created_at:new Date().toISOString()});}