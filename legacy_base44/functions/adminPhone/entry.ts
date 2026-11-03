import { setup, request, log, complete } from '../../shared/provisioning.ts';
import { adminSettings } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
export default async function(req){
 try{const {base44,input,settings:s}=await setup(req);if(!s.connected)throw new Error('Verify workspace access first.');
 if(input.action==='search'){
 const area=String(input.area_code || s.preferred_area_code || '');if(!/^\d{3}$/.test(area))throw new Error('Enter a three-digit area code.');
 try{const result=await request(s,`/phone-system/numbers/available?locationId=${encodeURIComponent(s.location_id)}&country=US&areaCode=${area}&type=local`);const rows=result.data.numbers || result.data.availableNumbers;if(!Array.isArray(rows))throw new Error('Provider returned an unsupported number-search response; purchase manually in GHL and save the assigned number in this step.');return Response.json({numbers:rows.slice(0,20).map(n=>({phoneNumber:n.phoneNumber || n.phone_number,friendlyName:n.friendlyName || n.phoneNumber}))});}catch(error){if(![404,405,501].includes(error.status))throw error;return Response.json({manual:true,instructions:'Enable the phone system on this workspace in GHL first. If number search remains unavailable, open Settings > Phone Numbers, search a US local number in your preferred area code, purchase it, then save the assigned number below.'});}
 }
 if(input.action==='purchase'){
 if(input.confirmed!==true||!/^\+[1-9]\d{7,14}$/.test(input.phone_number || ''))throw new Error('Confirm the purchase of a valid E.164 number.');if(s.phone_number)throw new Error('A texting number is already assigned. No second purchase was made.');
 try{const result=await request(s,'/phone-system/numbers/purchase','POST',{locationId:s.location_id,phoneNumber:input.phone_number});await log(base44,s,6,'phone_number',input.phone_number,result.data.id || input.phone_number,'POST /phone-system/numbers/purchase',result.status);return Response.json({settings:adminSettings(await complete(base44,s,6,{phone_number:input.phone_number}))});}catch(error){if(![404,405,501].includes(error.status))throw error;return Response.json({manual:true,instructions:'Number purchase is unavailable through this endpoint. Purchase in GHL > Settings > Phone Numbers, then save the assigned number below.'});}
 }
 throw new Error('Choose Search or Purchase.');
 }catch(error){return failure(error);}
}