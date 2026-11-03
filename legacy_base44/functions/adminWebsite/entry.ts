import { setup } from '../../shared/provisioning.ts';
import { mergeTemplate } from '../../shared/platformDefaults.ts';
import { failure } from '../../shared/ghl.ts';
export default async function(req){
 try{const {base44,input,settings:s,config}=await setup(req);
 if(input.action==='check'){
 if(!s.domain||! /^(?!.*(?:localhost|\.local$))(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(s.domain))throw new Error('Save a valid public domain first.');
 const results=await Promise.all(['','/get-info','/privacy','/sms-terms'].map(async path=>{const url=`https://${s.domain}${path}`;try{const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});await response.body?.cancel();return {url,status:response.status};}catch{return {url,status:0,error:'Could not reach URL'};}}));return Response.json({results});
 }
 const steps=config.default_sequence_campaign_id?(await base44.entities.SequenceStep.filter({campaign_id:config.default_sequence_campaign_id},{sort:'step_number',limit:10})).items:[];
 const samples=steps.filter(step=>step.variant!=='B').map(step=>step.body.replaceAll('{first}','{{first_name}}').replaceAll('{agent}',s.display_name || s.first_name || '').replaceAll('{agency}',s.brand_name || s.legal_business_name || '')).join('\n\n');
 return Response.json({website:mergeTemplate(config.website_spec_template,s),a2p:mergeTemplate(config.a2p_packet_template,s,{sample_messages:samples}),tests:mergeTemplate(config.test_plan_template,s)});
 }catch(error){return failure(error);}
}