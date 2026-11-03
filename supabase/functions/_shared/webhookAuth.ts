import { secrets } from './runtime.ts';
const publicKey='MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';
const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
export async function authenticWebhook(req,raw){
 const signature=req.headers.get('x-ghl-signature');
 if(signature!==null){try{const key=await crypto.subtle.importKey('spki',bytes(publicKey),{name:'Ed25519'},false,['verify']);return await crypto.subtle.verify('Ed25519',key,bytes(signature),new TextEncoder().encode(raw));}catch{return false;}}
 // Custom automation callbacks use the configured shared secret instead of marketplace signatures.
 const provided=new URL(req.url).searchParams.get('secret')||'',expected=secrets.get('RESPARK_WEBHOOK_SECRET');if(!expected||!provided)return false;
 const hash=async value=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [a,b]=await Promise.all([hash(provided),hash(expected)]);let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];return mismatch===0;
}