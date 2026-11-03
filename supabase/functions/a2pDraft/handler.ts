// Writes the agent's texting-program copy. Starts from the carrier-tested recommended program,
// lets the AI tailor the description and samples to the agent, and keeps any AI line that
// would fail carrier review on the recommended version instead.
import { setupContext, setupLog } from '../_shared/setupAccess.ts';
import { invokeLLM } from '../_shared/llm.ts';
import { failure } from '../_shared/ghl.ts';
import { registrationInput } from '../_shared/a2pRegistration.ts';
import { hostedSite, fillLinks, recommendedProgram, programBrand, sampleOk } from '../_shared/a2pProgram.ts';

export default async function (req: Request) {
  try {
    const { base44, E, s } = await setupContext(req);
    const input = await req.json();
    const data = registrationInput({ business_type: 'company', ...input });
    const brand = programBrand(data);
    if (!brand || brand === 'our agency') throw new Error('Enter your business or brand name first.');
    const key = `a2p_draft:${s.agent_email}`;
    const lock = await E.EngineCursor.upsert([{ key }], { key: 'key' });
    const record = lock.records[0];
    if (Number(record.cursor || 0) > Date.now() - 20000) throw new Error('Please wait a few seconds before rewriting again.');
    await E.EngineCursor.update(record.id, { cursor: String(Date.now()) });

    const site = await hostedSite(req, E, s);
    fillLinks(data, site);
    const rec = recommendedProgram(data, data.website === site.url ? site.opt_in_flow : '', s?.brand_name || '');
    const agent = data.first_name || 'the agent';
    let ai: any = {};
    try {
      ai = await invokeLLM(base44, {
        prompt: `You write US A2P 10DLC campaign copy that carriers approve on the first try.
Business: ${JSON.stringify(brand)}, a licensed life insurance agency. Agent first name: ${JSON.stringify(agent)}.
Use case: texting people who requested life insurance information from this business and checked a consent box naming it; following up, answering questions, booking phone appointments, appointment confirmations and reminders; policy service texts to existing clients.
Write:
- description: 300-600 characters, factual, third person, says who receives messages and why, mentions STOP/HELP. No guarantees, prices, or promises.
- sample_message_1: a friendly first follow-up from ${agent} asking if they still want to go over their options.
- sample_message_2: an appointment confirmation asking them to reply C to confirm or R to reschedule.
Every sample: under 300 characters, includes the exact text ${JSON.stringify(brand)}, ends with "Reply STOP to opt out.", uses the placeholder first name Sarah, contains NO links, NO phone numbers, NO emojis, NO all-caps words except STOP, no rates or guarantees.
Return only the three fields.`,
        response_json_schema: { type: 'object', properties: { description: { type: 'string' }, sample_message_1: { type: 'string' }, sample_message_2: { type: 'string' } }, required: ['description', 'sample_message_1', 'sample_message_2'] },
      });
    } catch { ai = {}; }

    const desc = String(ai.description || '').trim();
    const draft = {
      ...rec,
      description: desc.length >= 200 && desc.length <= 1500 && !/https?:|guarantee/i.test(desc) ? desc : rec.description,
      sample_message_1: sampleOk(ai.sample_message_1, brand) ? String(ai.sample_message_1).trim() : rec.sample_message_1,
      sample_message_2: sampleOk(ai.sample_message_2, brand) ? String(ai.sample_message_2).trim() : rec.sample_message_2,
      website: data.website, privacy_url: data.privacy_url, terms_url: data.terms_url,
    };
    await setupLog(E, s, 'a2p_draft', 'Generated texting program copy.');
    return Response.json({ draft });
  } catch (e) { return failure(e as Error); }
}
