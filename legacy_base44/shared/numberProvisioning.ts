import { setupLog } from './setupAccess.ts';
export async function phoneRequest(E,s,path){
 if(!s.connected||!s.location_id||!s.ghl_token)throw new Error('Your texting connection is awaiting administrator setup.');
 const response=await fetch(`https://services.leadconnectorhq.com${path}`,{headers:{Authorization:`Bearer ${s.ghl_token}`,Version:'2023-02-21',Accept:'application/json'},signal:AbortSignal.timeout(20000)});
 const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={message:'Provider returned a non-JSON response.'};}
 await setupLog(E,s,'phone_number',`GET ${path.split('?')[0]}`,response.status);return {status:response.status,ok:response.ok,body};
}
export function phoneRows(body){const data=body.data||body;const rows=Array.isArray(data)?data:data.numbers||data.availableNumbers||data.phoneNumbers||data.availablePhoneNumbers;return Array.isArray(rows)?rows:null;}