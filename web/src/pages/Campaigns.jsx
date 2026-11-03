import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Megaphone } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/workspace/PageHeader';
import EmptyState from '@/components/workspace/EmptyState';
import CampaignCard from '@/components/campaigns/CampaignCard';
import { call } from '@/components/workspace/api';
import { PanelSkeleton } from '@/components/system/Loaders';
import { useAction } from '@/lib/feedback';

export default function Campaigns() {
  const { settings, user } = useOutletContext();
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['campaigns', user?.email], initialPageParam: undefined, enabled: !!user?.email,
    queryFn: ({ pageParam }) => base44.entities.Campaign.filter({ agent_email: user.email }, { sort: 'created_date', limit: 50, cursor: pageParam }),
    getNextPageParam: p => (p.has_more ? p.next_cursor : undefined),
  });
  const playbooks = useQuery({ queryKey: ['playbooks'], queryFn: () => call('playbooks', {}) });
  const { run, busy } = useAction();
  const [justAdded, setJustAdded] = useState('');
  const campaigns = data?.pages.flatMap(p => p.items) || [];
  const all = playbooks.data?.playbooks || [];

  async function add(key) {
    const r = await run(key, () => call('playbooks', { action: 'add', key }), {
      ok: r => `${r?.name || 'Playbook'} added`,
      detail: 'It shows up in your campaigns above. Nobody gets a text until you import leads into it.',
      invalidate: [['campaigns'], ['playbooks']],
      next: { label: 'Import leads into it', to: '/contacts/import' },
    });
    if (r) setJustAdded(key);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Campaigns"
        description="Each campaign has its own AI conversation, follow-up texts and call documents, written for one kind of lead."
        actions={<Button variant="outline" asChild><Link to="/contacts/import">Import leads</Link></Button>}
      />

      <div className="space-y-4">
        {isLoading && <PanelSkeleton rows={3} />}
        {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
        {!isLoading && !campaigns.length && <section className="panel"><EmptyState icon={Megaphone} title="No campaigns yet" description="Add a playbook below to get a ready-made campaign."><Button onClick={() => document.getElementById('playbooks')?.scrollIntoView({ behavior: 'smooth' })}>Choose a playbook</Button></EmptyState></section>}
        {campaigns.filter(c => !c.archived).map(c => <CampaignCard key={c.id} campaign={c} settings={settings} user={user} />)}
        {hasNextPage && <Button variant="outline" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>Show more</Button>}
      </div>

      <section id="playbooks" className="scroll-mt-6">
        <h2 className="section-title mb-1">Playbooks</h2>
        <p className="mb-3 text-sm text-muted-foreground">Ready-made campaigns for a type of lead. Adding one doesn't text anyone until you import leads into it.</p>
        <ul className="panel divide-y">
          {all.map(p => (
            <li key={p.key} className={`flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4 ${justAdded === p.key ? 'lr-done' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-[13px] text-muted-foreground">{p.audience}. {p.description}</p>
              </div>
              {p.installed ? (
                <span className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">Added</span>
                  {justAdded === p.key && <Button size="sm" asChild className="lr-pop"><Link to="/contacts/import">Import leads</Link></Button>}
                </span>
              ) : <Button size="sm" variant="outline" loading={busy === p.key} disabled={!!busy && busy !== p.key} onClick={() => add(p.key)}>{busy === p.key ? 'Adding' : 'Add'}</Button>}
            </li>
          ))}
          <li className="flex items-center gap-6 px-4 py-4 text-muted-foreground">
            <div className="flex-1"><p className="text-sm font-medium">Mortgage Protection</p><p className="text-[13px]">Homeowners who asked about protecting their mortgage.</p></div>
            <span className="text-sm">Coming soon</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
