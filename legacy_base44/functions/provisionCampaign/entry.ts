import { setup, log, complete } from '../../shared/provisioning.ts';
import { adminSettings } from '../../shared/agentAccess.ts';
import { failure, scope } from '../../shared/ghl.ts';
export default async function(req){
 try{const {base44,input,settings:s,config}=await setup(req);if(input.action!=='clone')throw new Error('Choose Prepare campaign.');if(!s.location_id||!s.pipeline_id)throw new Error('Complete the workspace and data model first.');if(!config.default_sequence_campaign_id)throw new Error('Select a default campaign in Platform settings.');
 const source=await base44.asServiceRole.entities.Campaign.get(config.default_sequence_campaign_id);const old=await base44.asServiceRole.entities.Campaign.filter({agent_email:s.agent_email,name:source.name},{limit:1});let campaign=old.items[0];
 if(!campaign){campaign=await base44.asServiceRole.entities.Campaign.create({...scope(s),name:source.name,product:source.product,status:'draft',mode:'review',persona:source.persona || 'assistant',ab_enabled:source.ab_enabled,ab_lead_cap:source.ab_lead_cap || 200,system_prompt:source.system_prompt,knowledge_doc:source.knowledge_doc,writer_prompt:source.writer_prompt||'',personalize_sequence:source.personalize_sequence!==false,ai_model:source.ai_model||'claude-sonnet-5',prompt_version:source.prompt_version || 1,ghl_tag:source.ghl_tag,pipeline_id:s.pipeline_id,stage_ids:s.stage_ids});}
 else{campaign=await base44.asServiceRole.entities.Campaign.update(campaign.id,{location_id:s.location_id,pipeline_id:s.pipeline_id,stage_ids:s.stage_ids});}
 const templateSteps=(await base44.asServiceRole.entities.SequenceStep.filter({campaign_id:source.id},{sort:'step_number',limit:10})).items;
 const existing=(await base44.asServiceRole.entities.SequenceStep.filter({campaign_id:campaign.id},{limit:10})).items;
 const missing=templateSteps.filter(step=>!existing.some(v=>v.step_number===step.step_number&&v.variant===step.variant));
 if(missing.length)await base44.asServiceRole.entities.SequenceStep.bulkCreate(missing.map(step=>({...scope(s),campaign_id:campaign.id,step_number:step.step_number,variant:step.variant,day_offset:step.day_offset,lever:step.lever,brief:step.brief||'',body:step.body,requires_step1_delivered:step.requires_step1_delivered})));
 if(!(await base44.asServiceRole.entities.PromptVersion.count({campaign_id:campaign.id,version:campaign.prompt_version})))await base44.asServiceRole.entities.PromptVersion.create({...scope(s),campaign_id:campaign.id,version:campaign.prompt_version,system_prompt:campaign.system_prompt,knowledge_doc:campaign.knowledge_doc,writer_prompt:campaign.writer_prompt||'',notes:'Copied from default campaign; merge fields remain runtime values.'});
 await log(base44,s,8,'campaign',campaign.name,campaign.id,'Prepare agent-owned campaign without overwriting prompt edits');
 return Response.json({settings:adminSettings(await complete(base44,s,8)),campaign_id:campaign.id});
 }catch(error){return failure(error);}
}