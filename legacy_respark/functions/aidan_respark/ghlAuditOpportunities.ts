// Read-only audit: lists all GHL pipelines/stages and counts opportunities per stage/status.
const GHL_API_KEY = Deno.env.get('GHL_PRIVATE_INTEGRATION_TOKEN') || Deno.env.get('GHL_API_KEY') || 'pit-85b0f99f-d8cd-4e7d-9373-5213bd2548f0';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' };

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}));
    const pRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOC}`, { headers: H });
    const pJson = await pRes.json();
    const pipelines = pJson.pipelines || [];
    const stageName: Record<string, string> = {};
    const pipeName: Record<string, string> = {};
    for (const p of pipelines) { pipeName[p.id] = p.name; for (const s of p.stages) stageName[s.id] = s.name; }

    // Page through all opportunities
    const all: any[] = [];
    let startAfter: string | undefined, startAfterId: string | undefined;
    for (let i = 0; i < 60; i++) {
      const params = new URLSearchParams({ location_id: LOC, limit: '100' });
      if (startAfter) params.set('startAfter', startAfter);
      if (startAfterId) params.set('startAfterId', startAfterId);
      const r = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${params}`, { headers: H });
      if (!r.ok) return Response.json({ error: r.status, text: await r.text() }, { status: 500 });
      const j = await r.json();
      const opps = j.opportunities || [];
      all.push(...opps);
      const meta = j.meta || {};
      if (!meta.startAfter || opps.length === 0) break;
      startAfter = String(meta.startAfter); startAfterId = meta.startAfterId;
    }

    const counts: Record<string, any> = {};
    let withEmail = 0, noEmail = 0;
    const contactIds = new Set<string>();
    for (const o of all) {
      const key = `${pipeName[o.pipelineId] || o.pipelineId} > ${stageName[o.pipelineStageId] || o.pipelineStageId} [${o.status}]`;
      counts[key] = (counts[key] || 0) + 1;
      if (o.contact?.email) withEmail++; else noEmail++;
      if (o.contactId) contactIds.add(o.contactId);
    }

    const sample = body.sample ? all.slice(0, 3) : undefined;
    return Response.json({
      pipelines: pipelines.map((p: any) => ({ id: p.id, name: p.name, stages: p.stages.map((s: any) => ({ id: s.id, name: s.name })) })),
      total_opportunities: all.length,
      unique_contacts: contactIds.size,
      with_email: withEmail, no_email: noEmail,
      counts, sample,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
