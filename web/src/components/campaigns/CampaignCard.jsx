import { useState } from 'react';
import { MoreHorizontal, Loader2 } from 'lucide-react';
import { useAction } from '@/lib/feedback';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import StatusChip from '@/components/workspace/StatusChip';
import { call } from '@/components/workspace/api';
import CampaignMetrics from '@/components/campaigns/CampaignMetrics';
import PromptEditor from '@/components/campaigns/PromptEditor';
import SequenceEditor from '@/components/campaigns/SequenceEditor';
import TestConversation from '@/components/campaigns/TestConversation';
import CampaignMode from '@/components/campaigns/CampaignMode';
import PreviewSequence from '@/components/campaigns/PreviewSequence';
import TryMyAI from '@/components/dashboard/TryMyAI';
import CadencePanel from '@/components/campaigns/CadencePanel';

/** One campaign: its numbers, how replies are handled, and ways to test it. */
export default function CampaignCard({ campaign, settings, user }) {
  const { run, busy } = useAction();
  const [modal, setModal] = useState(null);
  const [flash, setFlash] = useState(false);
  const admin = user?.role === 'admin';

  async function toggleStatus() {
    const activating = campaign.status !== 'active';
    const ok = await run('status', async () => { await call('adminMessaging', { action: 'campaign_status', agent_email: campaign.agent_email, campaign_id: campaign.id, status: activating ? 'active' : 'paused' }); return true; }, {
      ok: activating ? 'Campaign activated' : 'Campaign paused',
      detail: activating ? `${campaign.name} is sending again within its texting hours.` : `No new texts go out for ${campaign.name} until you activate it.`,
      invalidate: [['campaigns']],
    });
    if (ok) { setFlash(true); setTimeout(() => setFlash(false), 1300); }
  }

  return (
    <>
      <article className={`panel ${flash ? 'lr-done' : ''}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 className="truncate text-[15px] font-semibold">{campaign.name}</h2>
            <StatusChip status={campaign.status} label={campaign.status === 'draft' ? (settings?.status === 'live' ? 'Starts when leads are imported' : 'Starts when texting is approved') : undefined} />
            {busy === 'status' && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" />Saving</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <CampaignMode campaign={campaign} user={user} />
            <Button size="sm" variant="outline" className={admin ? 'hidden sm:inline-flex' : ''} onClick={() => setModal('preview')}>Preview texts</Button>
            <Button size="sm" onClick={() => setModal(admin ? 'test' : 'try')}>Test the AI</Button>
            {admin && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="w-8 px-0" aria-label="Campaign settings"><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="sm:hidden" onSelect={() => setModal('preview')}>Preview texts</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setModal('sequence')}>Edit follow-up texts</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setModal('prompt')}>Edit AI instructions</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={busy === 'status'} onSelect={toggleStatus}>{campaign.status === 'active' ? 'Pause campaign' : 'Activate campaign'}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <div className="space-y-3 p-4">
          <CampaignMetrics campaign={campaign} />
          {campaign.cadence && <CadencePanel campaign={campaign} />}
        </div>
      </article>
      {modal === 'prompt' && <PromptEditor campaign={campaign} onClose={() => setModal(null)} />}
      {modal === 'sequence' && <SequenceEditor campaign={campaign} onClose={() => setModal(null)} />}
      {modal === 'test' && <TestConversation campaign={campaign} settings={settings} onClose={() => setModal(null)} />}
      {modal === 'preview' && <PreviewSequence campaign={campaign} onClose={() => setModal(null)} />}
      <TryMyAI open={modal === 'try'} onClose={() => setModal(null)} settings={settings} />
    </>
  );
}
