import { context, own, failure } from '../../shared/ghl.ts';
export default async function(req) {
 try { const {base44,user}=await context(req);const input=await req.json();if(typeof input.campaign_id!=='string'||!input.campaign_id)throw new Error('Choose a campaign.');const campaign=own(user,await base44.entities.Campaign.get(input.campaign_id));const query={campaign_id:campaign.id,agent_email:campaign.agent_email};
 const statuses=await Promise.all(['in_sequence','booked','opted_out'].map(async status=>({status,count:await base44.entities.Lead.count({...query,status})})));
 const drafts=await Promise.all(['pending','approved','edited','discarded','sent'].map(async status=>({status,count:await base44.entities.AIDraft.count({...query,status})})));
 return Response.json({statuses,drafts});
 }catch(error){return failure(error);}
}