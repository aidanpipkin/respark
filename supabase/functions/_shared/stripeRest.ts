import { secrets } from './runtime.ts';
export async function stripeRest(path: string, body?: Record<string, any>, key?: string): Promise<any> {
 const credential=secrets.get('STRIPE_SECRET_KEY');if(!credential)throw new Error('Billing is not configured.');
 const response=await fetch(`https://api.stripe.com/v1/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${credential}`,'Stripe-Version':'2024-06-20',...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?new URLSearchParams(body).toString():undefined,signal:AbortSignal.timeout(20000)});
 const data=await response.json();if(!response.ok)throw new Error(data.error?.message||`Billing request failed (${response.status}).`);return data;
}
export async function billingAccount(E,email){const p=await E.BillingAccount.filter({agent_email:email},{limit:1});return p.items[0];}
export function cardSummary(a){return a?{status:a.status,brand:a.brand,last4:a.last4,exp_month:a.exp_month,exp_year:a.exp_year}:null;}