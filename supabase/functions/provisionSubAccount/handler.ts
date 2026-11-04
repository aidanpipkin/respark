import { setup, request, log, complete } from '../_shared/provisioning.ts';
import { adminSettings } from '../_shared/agentAccess.ts';
import { failure } from '../_shared/ghl.ts';
// The owner's name for the GHL user record: the owner's profile (full_name split on the last space),
// else the mailbox part of owner_email, else a neutral placeholder. Never a hard-coded person.
async function ownerDisplayName(base44,config){
 const email=String(config.owner_email||'').toLowerCase();
 let full='';
 try{const users=await base44.asServiceRole.entities.User.filter({email},{limit:1});full=String(users.items[0]?.full_name||'').trim();}catch{/* profile lookup is best effort */}
 if(full){const parts=full.split(/\s+/);return parts.length>1?{first:parts.slice(0,-1).join(' '),last:parts[parts.length-1]}:{first:full,last:'Owner'};}
 const local=email.split('@')[0]||'';
 const guess=local.split(/[._-]+/).filter(Boolean).map(w=>w.charAt(0).toUpperCase()+w.slice(1));
 if(guess.length>1)return {first:guess.slice(0,-1).join(' '),last:guess[guess.length-1]};
 return {first:guess[0]||'Platform',last:'Owner'};
}
export default async function(req) {
 try { const {base44,input,settings:s,config}=await setup(req);
 if(input.action==='verify') {
 if(typeof input.credential!=='string'||input.credential.length<10||input.credential.length>4000||!s.location_id)throw new Error('Enter a workspace credential for the provisioned account.');
 const candidate={...s,ghl_token:input.credential.trim()};const result=await request(candidate,`/locations/${encodeURIComponent(s.location_id)}`);
 const verified=result.data.location || result.data;if(verified.id!==s.location_id)throw new Error('Credential verification returned a different workspace.');
 for(const probe of [`/locations/${encodeURIComponent(s.location_id)}/customValues`,`/contacts/?locationId=${encodeURIComponent(s.location_id)}&limit=1`]){try{await request(candidate,probe);}catch(error){if([401,403].includes(error.status))throw new Error('This credential can see the workspace but cannot manage its contacts or settings. It is probably an agency credential. Create the integration inside the sub-account (Settings > Private Integrations) with all scopes, then paste that one.');throw error;}}
 const saved=await complete(base44,s,2,{ghl_token:candidate.ghl_token,connected:true,token_kind:'pit',ghl_token_expires_at:''});return Response.json({settings:adminSettings(saved),verified:true});
 }
 if(input.action!=='provision')throw new Error('Choose Provision or Verify.');
 if(!s.legal_business_name||!s.business_phone||!s.business_email||!s.address_street||!s.address_city||!s.address_state||!s.address_zip)throw new Error('Complete the legal business profile and structured address first.');
 if(!s.location_id){
 const result=await request(s,'/locations/','POST',{name:`${s.legal_business_name} – Respark`,phone:s.business_phone,companyId:config.agency_company_id,address:s.address_street,city:s.address_city,state:s.address_state,country:'US',postalCode:s.address_zip,...(s.domain?{website:`https://${s.domain}`} : {}),timezone:s.home_timezone || config.default_timezone,prospectInfo:{firstName:s.first_name,lastName:s.last_name || '',email:s.business_email},settings:{allowDuplicateContact:false,allowDuplicateOpportunity:false,allowFacebookNameMerge:false,disableContactTimezone:false},social:{}},true);
 s.location_id=result.data.location?.id || result.data.id;if(!s.location_id)throw new Error('Creation response omitted the workspace ID. Check the provider before retrying.');
 await base44.asServiceRole.entities.AgentSettings.update(s.id,{location_id:s.location_id});await log(base44,s,2,'workspace',s.legal_business_name,s.location_id,'POST /locations/',result.status);
 }
 if(!s.owner_user_id){
 const ownerName=await ownerDisplayName(base44,config);
 let owner;const found=await request(s,`/users/search?companyId=${encodeURIComponent(config.agency_company_id)}&query=${encodeURIComponent(config.owner_email)}`,'GET',undefined,true);
 owner=(found.data.users || []).find(u=>String(u.email).toLowerCase()===config.owner_email.toLowerCase());
 if(!owner){try {const created=await request(s,'/users/','POST',{companyId:config.agency_company_id,firstName:ownerName.first,lastName:ownerName.last,email:config.owner_email,type:'account',role:'admin',locationIds:[s.location_id],permissions:{campaignsEnabled:true,campaignsReadOnly:false,contactsEnabled:true,workflowsEnabled:true,workflowsReadOnly:false,triggersEnabled:true,funnelsEnabled:true,websitesEnabled:true,opportunitiesEnabled:true,dashboardStatsEnabled:true,bulkRequestsEnabled:true,appointmentsEnabled:true,reviewsEnabled:true,onlineListingsEnabled:true,phoneCallEnabled:true,conversationsEnabled:true,assignedDataOnly:false,adwordsReportingEnabled:true,membershipEnabled:true,settingsEnabled:true}},true);owner=created.data.user || created.data;await log(base44,s,2,'user',config.owner_email,owner.id,'POST /users/',created.status);}catch(error){if(![400,422].includes(error.status)||!/exist|duplicate/i.test(error.message))throw error;const retry=await request(s,`/users/search?companyId=${encodeURIComponent(config.agency_company_id)}&query=${encodeURIComponent(config.owner_email)}`,'GET',undefined,true);owner=(retry.data.users || []).find(u=>u.email?.toLowerCase()===config.owner_email.toLowerCase());if(!owner)throw error;}}
 if(!owner.id)throw new Error('Owner user ID missing. Check provider user setup.');
 const locations=[...new Set([...(owner.locationIds || owner.roles?.locationIds || []),s.location_id])];
 const updated=await request(s,`/users/${encodeURIComponent(owner.id)}`,'PUT',{locationIds:locations},true);await log(base44,s,2,'user_access',config.owner_email,owner.id,'PUT /users/{id}: add workspace',updated.status);
 s.owner_user_id=owner.id;await base44.asServiceRole.entities.AgentSettings.update(s.id,{owner_user_id:owner.id});
 }
 return Response.json({settings:adminSettings(s)});
 }catch(error){return failure(error);}
}