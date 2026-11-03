import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { notify, useAction } from '@/lib/feedback';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
export default function CampaignMode({campaign,user}) {
  const [open,setOpen]=useState(false);const {run,busy}=useAction();
  const {data,isLoading,isError}=useQuery({queryKey:['approval',campaign.id],enabled:open,queryFn:async()=>{const progress=await call('campaignProgress',{campaign_id:campaign.id});const stats={rows:progress.drafts};return {total:stats.rows.reduce((sum,r)=>sum+r.count,0),approved:stats.rows.find(r=>r.status==='approved')?.count || 0};}});
  async function change(mode){
    if(mode===campaign.mode||(mode==='review'&&campaign.mode!=='autopilot')){setOpen(false);notify.info(mode==='autopilot'?'Already on autopilot':'Already set to review','Nothing changed.');return;}
    const ok=await run(mode,async()=>{await call('saveCampaign',{action:'mode',campaign_id:campaign.id,mode,confirmed:true});return true;},{
      ok:mode==='autopilot'?'Autopilot on':'Switched to review',
      detail:mode==='autopilot'?`The AI now replies by itself for ${campaign.name}.`:`New replies for ${campaign.name} wait for your approval.`,
      next:mode==='review'?{label:'Open inbox',to:'/inbox'}:null,
      invalidate:[['campaigns']],
    });
    if(ok) setOpen(false);
  }
  return <><Button size="sm" variant="ghost" className="text-muted-foreground" onClick={()=>setOpen(true)} title="How replies are sent">{campaign.mode==='autopilot'?'AI replies automatically':'You approve replies'}</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>How replies go out</DialogTitle><DialogDescription>In review, you approve each suggested reply to a lead who texted back. On autopilot, the AI replies by itself. The pre-written follow-up series sends on schedule in both modes. Autopilot is turned on by an admin.</DialogDescription></DialogHeader><div className="rounded-lg bg-muted p-4"><p className="text-sm text-muted-foreground">Replies you approved without editing</p><p className="mt-1 text-2xl font-semibold tabular-nums">{isLoading?'…':data?.total?`${(data.approved/data.total*100).toFixed(1)}%`:'No reviewed drafts yet'}</p><p className="mt-1 text-sm text-muted-foreground">{data?.approved || 0} of {data?.total || 0} suggested replies</p></div><p className="text-sm text-muted-foreground">Autopilot only sends when your account is on autopilot too, the campaign is active, and consent, opt-out and sending-hour checks pass.</p>{user.role!=='admin'&&<p className="text-xs text-muted-foreground">Ask your admin to enable Autopilot.</p>}<div className="flex justify-end gap-2"><Button variant="outline" loading={busy==='review'} disabled={!!busy} onClick={()=>change('review')}>I'll approve replies</Button><Button loading={busy==='autopilot'} disabled={!!busy||user.role!=='admin'||isLoading||isError} onClick={()=>change('autopilot')}>Turn on autopilot</Button></div></DialogContent></Dialog></>;
}