export const products=['IUL','Term','Final Expense','Mortgage Protection','Whole Life','Unknown'];
export const states='AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
// Prefer a real first name; display names copied from an email handle ("aidan.pipkin") are not shown publicly.
export function displayName(s){const looksLikeHandle=v=>/[.@_]|\d/.test(String(v||''));const first=String(s.first_name||'').trim();const disp=String(s.display_name||'').trim().split(/\s+/)[0];const pick=first&&!looksLikeHandle(first)?first:disp&&!looksLikeHandle(disp)?disp:'Your agent';return pick.charAt(0).toUpperCase()+pick.slice(1);}
export function businessName(s){return String(s.legal_business_name||s.brand_name||[s.first_name,s.last_name].filter(Boolean).join(' ')||'our office').trim();}
export function consentText(s){return `By checking this box, I agree to receive text messages from ${displayName(s)} of ${businessName(s)} about life insurance options at the number provided, including messages sent using automated technology. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. See our Privacy Policy and Terms.`;}
export async function resolvePublicAgent(base44,input){
 const host=String(input.host||'').trim().toLowerCase().replace(/^www\./,'');const slug=String(input.agent||'').trim().toLowerCase();
 if(host.length>253||slug.length>100)throw new Error('Invalid website.');
 const E=base44.asServiceRole.entities;let s;
 if(/^[a-z\d.-]+$/.test(host)){const p=await E.AgentSettings.filter({domain:host},{limit:1});s=p.items[0];}
 if(!s&&/^[a-z\d-]+$/.test(slug)){const p=await E.AgentSettings.filter({public_slug:slug},{limit:1});s=p.items[0];}
 if(!s&&input.strict===true)throw Object.assign(new Error('This page could not be found.'),{status:404});
 if(!s){const p=await E.PlatformSettings.filter({singleton_key:'platform'},{limit:1});if(p.items[0]?.owner_email){const a=await E.AgentSettings.filter({agent_email:p.items[0].owner_email},{limit:1});s=a.items[0];}}
 if(!s)throw Object.assign(new Error('This website is not configured yet.'),{status:404});return s;
}
export async function safePublicSite(base44,s){
 const keys=['brand_name','agent_title','licensed_states','npn','legal_business_name','business_address','business_email','business_phone','primary_color','accent_color','calendar_id','booking_url','domain','public_slug'];const out=Object.fromEntries(keys.map(k=>[k,s[k]??(['licensed_states'].includes(k)?[]:'')]));out.display_name=displayName(s);out.products=s.products_offered||s.products||[];out.business_name=businessName(s);out.business_phone=(m=>m?`(${m[1]}) ${m[2]}-${m[3]}`:out.business_phone)(String(s.business_phone||'').match(/^\+1(\d{3})(\d{3})(\d{4})$/));out.consent_text=consentText(s);out.chat_widget_id=/^[a-f0-9]{24}$/.test(String(s.chat_widget_id||''))?s.chat_widget_id:'';out.first_name=s.first_name||'';out.business_city=s.address_city||'';out.business_state=s.address_state||'';
 out.about_text=String(s.about_text||'').slice(0,4000);if(s.last_name){const escaped=s.last_name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');out.about_text=out.about_text.replace(new RegExp(`\\b${escaped}\\b`,'gi'),'').replace(/ {2,}/g,' ');}
 for(const k of ['logo_url','headshot_url']){const value=s[k]||'';if(!value)out[k]='';else if(value.startsWith('https://'))out[k]=value;else {const r=await base44.asServiceRole.integrations.Core.CreateFileSignedUrl({file_uri:value});out[k]=r.signed_url;}}
 return out;
}