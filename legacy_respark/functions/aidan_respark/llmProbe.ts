import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const out: any = {};
  try {
    const r = await (base44 as any).asServiceRole.integrations.Core.InvokeLLM({
      prompt: 'Reply with JSON {"ok":true,"word":"<one word>"}',
      response_json_schema: { type: 'object', properties: { ok: { type: 'boolean' }, word: { type: 'string' } } },
    });
    out.llm = r;
  } catch (e) { out.llm_err = String(e).slice(0, 300); }
  try {
    const c = await (base44 as any).asServiceRole.connectors.getConnection('outlook');
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail', { headers: { Authorization: `Bearer ${c.token}` } });
    out.outlook = await res.json();
  } catch (e) { out.outlook_err = String(e).slice(0, 300); }
  return Response.json(out);
});
