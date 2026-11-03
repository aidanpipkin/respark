import { adminContext, adminSettings } from '../../shared/agentAccess.ts';
import { agentSettings, failure } from '../../shared/ghl.ts';
import { applyCredit } from '../../shared/credits.ts';
import { approveAgent } from '../../shared/approval.ts';
async function platformConfigLite(base44){return (await base44.asServiceRole.entities.PlatformSettings.filter({singleton_key:'platform'},{limit:1})).items[0];}
const fields = ['chat_widget_id','about_text','public_slug','first_name','last_name','display_name','legal_business_name','brand_name','agent_title','npn','business_address','address_street','address_city','address_state','address_zip','business_email','business_phone','alert_mobile','home_timezone','domain','primary_color','accent_color','logo_url','headshot_url','licensed_states','products_offered','calendar_hours','max_calls_per_day','preferred_area_code','test_phone_numbers','onboarding_checks','a2p_status','a2p_notes','onboarding_step','phone_number','beta_access'];
export default async function(req) {
 try { const {base44}=await adminContext(req); const input=await req.json();
 if(input.action==='pending_count'){const c=await platformConfigLite(base44);if(c?.self_serve_requires_approval!==true)return Response.json({pending:0});const n=await base44.asServiceRole.entities.AgentSettings.count({self_serve:true,beta_access:{$ne:true},$or:[{location_id:{$exists:false}},{location_id:null},{location_id:''}]});return Response.json({pending:n});}
 if(input.action==='list') { const query={}; if(input.search)query.$or=[{agent_email:{$regex:String(input.search).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}},{brand_name:{$regex:String(input.search).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'}}];const page=await base44.asServiceRole.entities.AgentSettings.filter(query,{sort:'-created_date',limit:25,cursor:input.cursor});const emails=page.items.map(i=>i.agent_email).filter(Boolean);const wallets=emails.length?(await base44.asServiceRole.entities.BillingAccount.filter({agent_email:{$in:emails}},{limit:50})).items:[];const credit=e=>{const w=wallets.find(x=>x.agent_email===e);return w?{card:w.status==='card_saved',balance_cents:Number(w.balance_cents)||0,auto_recharge:!!w.auto_recharge,recharge_error:w.last_recharge_error||'',lifetime_texts:Number(w.lifetime_texts)||0}:{card:false,balance_cents:0,auto_recharge:false,recharge_error:'',lifetime_texts:0};};return Response.json({...page,items:page.items.map(i=>({...adminSettings(i),credits:credit(i.agent_email)}))}); }
 if(input.action==='grant_credits'){const amount=Number(input.amount_cents);if(!Number.isInteger(amount)||amount===0||Math.abs(amount)>100000)throw new Error('Enter a credit amount up to $1,000.');const target=(await base44.asServiceRole.entities.AgentSettings.get(input.id));if(!target?.agent_email)throw new Error('Agent not found.');const E=base44.asServiceRole.entities;let w=(await E.BillingAccount.filter({agent_email:target.agent_email},{limit:1})).items[0];if(!w)w=await E.BillingAccount.create({agent_email:target.agent_email,status:'not_started',balance_cents:0});const balance=await applyCredit(E,target.agent_email,amount,{kind:'adjustment',description:String(input.note||(amount>0?'Credits added by your administrator':'Credit correction')).slice(0,120)});return Response.json({balance_cents:balance}); }
 const email=String(input.agent_email||'').toLowerCase().trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid agent login email.');
 let s=await agentSettings(base44,email);
 if(input.action==='save') {
 const update={};for(const key of fields)if(input[key]!==undefined)update[key]=input[key];
 for(const key of ['business_phone','alert_mobile','phone_number'])if(update[key]&&!/^\+[1-9]\d{7,14}$/.test(update[key]))throw new Error(`${key}: use E.164 phone format.`);
 if(update.domain){update.domain=String(update.domain).toLowerCase().replace(/^https?:\/\//,'').replace(/\/$/,'');if(!/^(?!.*(?:localhost|\.local$))(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(update.domain))throw new Error('Enter a public domain name without a path.');}
 for(const key of ['primary_color','accent_color'])if(update[key]&&!/^#[\da-fA-F]{6}$/.test(update[key]))throw new Error('Use a six-digit hex color.');
 if(update.home_timezone)new Intl.DateTimeFormat('en-US',{timeZone:update.home_timezone}).format();
 if(update.licensed_states&&(!Array.isArray(update.licensed_states)||update.licensed_states.some(v=>typeof v!=='string'||! /^[A-Z]{2}$/.test(v))))throw new Error('Choose valid state abbreviations.');
 if(update.test_phone_numbers&&(!Array.isArray(update.test_phone_numbers)||update.test_phone_numbers.length>2||update.test_phone_numbers.some(v=>!/^\+[1-9]\d{7,14}$/.test(v))))throw new Error('Use up to two E.164 test numbers.');
 if(update.max_calls_per_day!==undefined&&(!Number.isInteger(update.max_calls_per_day)||update.max_calls_per_day<1||update.max_calls_per_day>30))throw new Error('Maximum calls must be between 1 and 30.');
 if(update.a2p_notes && /\b\d{2}-\d{7}\b|\bEIN\s*[:#=]?\s*\d/i.test(update.a2p_notes))throw new Error('Do not store an EIN here. Enter it only in the carrier registration portal.');
 if(update.calendar_hours && (!Array.isArray(update.calendar_hours)||update.calendar_hours.length>7||new Set(update.calendar_hours.map(h=>h.day)).size!==update.calendar_hours.length||update.calendar_hours.some(h=>!Number.isInteger(h.day)||h.day<0||h.day>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.open)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.close)||h.open>=h.close)))throw new Error('Use one valid opening period per day.');
 if(JSON.stringify(update).length>40000)throw new Error('Profile is too large.');
 if(update.about_text!==undefined&&(typeof update.about_text!=='string'||update.about_text.length>4000))throw new Error('About text must be under 4,000 characters.');
 if(update.chat_widget_id&&!/^[a-f0-9]{24}$/.test(String(update.chat_widget_id)))throw new Error('The chat widget ID is the 24-character data-widget-id from the LeadConnector embed code.');
 if(update.public_slug&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(update.public_slug))throw new Error('Use lowercase letters, numbers and hyphens for the public slug.');
 if(update.products_offered)update.products=update.products_offered;
 if(update.legal_business_name)update.agency_name=update.legal_business_name;
 if(!s){s=await base44.asServiceRole.entities.AgentSettings.create({agent_email:email,status:'onboarding',onboarding_step:1,mode:'review',...update});}else{s=await base44.asServiceRole.entities.AgentSettings.update(s.id,update);}
 // Approval closes the signup signal, starts the workspace build immediately (profile permitting) and emails the agent.
 if(update.beta_access===true){const config=await platformConfigLite(base44);const out=await approveAgent(base44,s,config||{},'admin').catch((e)=>{console.error('[adminAgents] approve failed',e.message);return null;});if(out?.settings)s=out.settings;}
 }
 if(!s)throw new Error('Agent not found.');return Response.json({settings:adminSettings(s)});
 }catch(error){return failure(error);}
}