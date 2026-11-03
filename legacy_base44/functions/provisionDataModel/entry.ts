import { setup, request, log, complete } from '../../shared/provisioning.ts';
import { stageNames,stageKeys,tagNames,fields,customValues } from '../../shared/dataModelSpec.ts';
import { adminSettings } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
export default async function(req){
 try{const {base44,input,settings:s}=await setup(req);if(input.action!=='build')throw new Error('Choose Build.');if(!s.connected)throw new Error('Verify workspace access first.');const loc=encodeURIComponent(s.location_id);
 const [valuesResult,fieldsResult,tagsResult,pipelinesResult]=await Promise.all([request(s,`/locations/${loc}/customValues`),request(s,`/locations/${loc}/customFields`),request(s,`/locations/${loc}/tags`),request(s,`/opportunities/pipelines?locationId=${loc}`)]);
 const custom_value_ids={},custom_field_ids={},tag_ids={};
 async function buildGroup(specs,existing,path,type,target,step,updateExisting=false){
 for(let offset=0;offset<specs.length;offset+=3){const results=await Promise.allSettled(specs.slice(offset,offset+3).map(async spec=>{
 const savedIds=type==='customValue'?s.custom_value_ids:type==='customField'?s.custom_field_ids:s.tag_ids;
 let item=existing.find(x=>x.id===savedIds?.[spec.name]) || existing.find(x=>x.name?.toLowerCase()===spec.name.toLowerCase());
 if(!item){const created=await request(s,path,'POST',spec);item=created.data[type] || created.data;if(!item.id)throw new Error(`Missing ID for ${spec.name}; inspect provider before retrying.`);await log(base44,s,step,type,spec.name,item.id,`POST ${path}`,created.status);}
 else if(updateExisting){const updated=await request(s,`${path}/${encodeURIComponent(item.id)}`,'PUT',spec);await log(base44,s,step,type,spec.name,item.id,`PUT ${path}/{id}`,updated.status);}
 target[spec.name]=item.id;
 }));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;}
 }
 await buildGroup(Object.entries(customValues(s)).map(([name,value])=>({name,value:String(value||' ')})),valuesResult.data.customValues || [],`/locations/${loc}/customValues`,'customValue',custom_value_ids,3,true);
 await base44.asServiceRole.entities.AgentSettings.update(s.id,{custom_value_ids});
 await buildGroup(fields.map(f=>({...f,model:'contact'})),fieldsResult.data.customFields || [],`/locations/${loc}/customFields`,'customField',custom_field_ids,3);
 await base44.asServiceRole.entities.AgentSettings.update(s.id,{custom_field_ids});
 await buildGroup(tagNames.map(name=>({name})),tagsResult.data.tags || [],`/locations/${loc}/tags`,'tag',tag_ids,3);
 await base44.asServiceRole.entities.AgentSettings.update(s.id,{tag_ids});
 let pipeline=(pipelinesResult.data.pipelines || []).find(p=>p.id===s.pipeline_id) || (pipelinesResult.data.pipelines || []).find(p=>p.name==='Respark');
 if(!pipeline){try{const result=await request(s,'/opportunities/pipelines','POST',{locationId:s.location_id,name:'Respark',showInFunnel:true,showInPieChart:true,stages:stageNames.map((name,position)=>({name,position}))});pipeline=result.data.pipeline || result.data;await log(base44,s,3,'pipeline','Respark',pipeline.id,'POST /opportunities/pipelines',result.status);}catch(error){if(![404,405,501].includes(error.status))throw error;return Response.json({manual:true,instructions:`Pipeline creation is unavailable through this endpoint. In GHL create the Respark pipeline with these stages in order: ${stageNames.join(', ')}. Run Build again to discover and save their IDs.`,settings:adminSettings({...s,custom_value_ids,custom_field_ids,tag_ids})});}}
 if(!pipeline.id)throw new Error('Pipeline response omitted its ID.');const stage_ids={};stageNames.forEach((name,i)=>{const stage=(pipeline.stages||[]).find(v=>v.name===name);if(stage)stage_ids[stageKeys[i]]=stage.id;});
 if(Object.keys(stage_ids).length!==stageNames.length)throw new Error('The existing Respark pipeline is missing required stages. Add them in GHL, then run Build again.');
 const saved=await complete(base44,s,3,{custom_value_ids,custom_field_ids,tag_ids,pipeline_id:pipeline.id,stage_ids});return Response.json({settings:adminSettings(saved)});
 }catch(error){return failure(error);}
}