import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { useAction } from '@/lib/feedback';

export default function CampaignStatusControl({ campaign }) {
  const { run, busy } = useAction();
  const [flash, setFlash] = useState(false);
  const activating = campaign.status !== 'active';

  async function change() {
    const ok = await run('status', async () => {
      await call('adminMessaging', { action: 'campaign_status', agent_email: campaign.agent_email, campaign_id: campaign.id, status: activating ? 'active' : 'paused' });
      return true;
    }, {
      ok: activating ? 'Campaign activated' : 'Campaign paused',
      detail: activating ? `${campaign.name || 'This campaign'} is sending again within its texting hours.` : `No new texts go out for ${campaign.name || 'this campaign'} until you activate it.`,
      invalidate: [['campaigns']],
    });
    if (ok) { setFlash(true); setTimeout(() => setFlash(false), 1300); }
  }

  return (
    <div>
      <Button variant="outline" className={`h-10 text-xs ${flash ? 'lr-done' : ''}`} loading={busy === 'status'} onClick={change}>
        {busy === 'status' ? 'Saving' : activating ? 'Activate campaign' : 'Pause campaign'}
      </Button>
    </div>
  );
}
