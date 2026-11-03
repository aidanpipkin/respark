// Admin: Twilio connection for automatic A2P registration and number purchase.
import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { platform } from '../../shared/provisioning.ts';
import { masterCred, twilioConfigured, tw, subCred, API, TRUST } from '../../shared/twilio.ts';

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const input = await req.json().catch(() => ({}));
    const E = base44.asServiceRole.entities;
    let config = await platform(base44);

    if (input.action === 'save') {
      const update: Record<string, any> = {};
      if (input.twilio_primary_profile_sid !== undefined) { const v = String(input.twilio_primary_profile_sid).trim(); if (v && !/^BU[0-9a-f]{32}$/i.test(v)) throw new Error('The Primary Customer Profile SID starts with BU and has 34 characters.'); update.twilio_primary_profile_sid = v; }
      if (input.twilio_isv_email !== undefined) { const v = String(input.twilio_isv_email).trim(); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('Enter a valid email.'); update.twilio_isv_email = v; }
      if (input.a2p_provider !== undefined) { if (!['manual', 'twilio'].includes(input.a2p_provider)) throw new Error('Choose a provider.'); if (input.a2p_provider === 'twilio' && (!twilioConfigured() || !(update.twilio_primary_profile_sid ?? config.twilio_primary_profile_sid))) throw new Error('Add the Twilio secrets and your Primary Customer Profile SID before turning on automatic registration.'); update.a2p_provider = input.a2p_provider; }
      config = await E.PlatformSettings.update(config.id, update);
    }

    if (input.action === 'diagnose_isv') {
      // Read-only look at why subaccount registrations can't use the Primary profile. Never returns tax IDs.
      const out: Record<string, any> = {};
      const cred = masterCred();
      const prim = config.twilio_primary_profile_sid;
      try {
        const p = await tw(cred, `${TRUST}/CustomerProfiles/${prim}`);
        out.primary = { status: p.status, policy_sid: p.policy_sid, friendly_name: p.friendly_name, valid_until: p.valid_until };
        const ents = await tw(cred, `${TRUST}/CustomerProfiles/${prim}/EntityAssignments?PageSize=50`);
        out.primary_entities = [];
        for (const a of ents.results || []) {
          const sid = String(a.object_sid || '');
          const row: Record<string, any> = { object_sid_prefix: sid.slice(0, 2) };
          if (sid.startsWith('IT')) { try { const u = await tw(cred, `${TRUST}/EndUsers/${sid}`); row.type = u.type; const at = u.attributes || {}; row.business_type = at.business_type; row.business_industry = at.business_industry; row.business_identity = at.business_identity; row.business_registration_identifier = at.business_registration_identifier; row.business_regions_of_operation = at.business_regions_of_operation; row.attribute_keys = Object.keys(at); } catch (e) { row.error = (e as Error).message; } }
          out.primary_entities.push(row);
        }
      } catch (e) { out.primary_error = (e as Error).message; }
      const acct = (await E.TwilioAccount.filter({}, { sort: '-created_at', limit: 1 })).items[0];
      if (acct?.subaccount_sid) {
        const sc = await subCred(acct.subaccount_sid);
        let sec: any = null;
        try {
          sec = await tw(sc, `${TRUST}/CustomerProfiles`, { FriendlyName: 'LeadRespark ISV diagnosis', Email: config.twilio_isv_email || config.owner_email, PolicySid: 'RNdfbf3fae0e1107f8aded0e7cead80bf5' });
          try { await tw(sc, `${TRUST}/CustomerProfiles/${sec.sid}/EntityAssignments`, { ObjectSid: prim }); out.assign_from_subaccount = 'ok'; } catch (e) { out.assign_from_subaccount = (e as Error).message; }
          try { const ev = await tw(sc, `${TRUST}/CustomerProfiles/${sec.sid}/Evaluations`, { PolicySid: 'RNdfbf3fae0e1107f8aded0e7cead80bf5' }); out.evaluation = (ev.results || []).filter((r: any) => r.passed === false).map((r: any) => ({ requirement: r.requirement_name || r.object_type, failure: r.failure_reason, fields: (r.fields || []).filter((f: any) => f.passed === false).map((f: any) => `${f.object_field}: ${f.failure_reason}`) })); } catch (e) { out.evaluation_error = (e as Error).message; }
        } catch (e) { out.secondary_error = (e as Error).message; }
        finally { if (sec?.sid) await tw(sc, `${TRUST}/CustomerProfiles/${sec.sid}`, undefined, 'DELETE').catch(() => {}); }
      }
      return Response.json(out);
    }
    if (input.action === 'set_subaccount') {
      const email = String(input.agent_email || '').toLowerCase().trim(), sid = String(input.subaccount_sid || '').trim();
      if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error('Twilio account SIDs start with AC and have 34 characters.');
      await tw(masterCred(), `${API}/Accounts/${sid}.json`);
      const existing = (await E.TwilioAccount.filter({ agent_email: email }, { limit: 1 })).items[0];
      if (existing) await E.TwilioAccount.update(existing.id, { subaccount_sid: sid, source: 'admin' });
      else await E.TwilioAccount.create({ agent_email: email, subaccount_sid: sid, source: 'admin', created_at: new Date().toISOString() });
    }

    const status: Record<string, any> = { credentials: twilioConfigured(), account: null, primary_profile: null, error: '' };
    if (status.credentials) {
      try {
        const cred = masterCred();
        const acct = await tw(cred, `${API}/Accounts/${cred.sid}.json`);
        status.account = { name: acct.friendly_name, status: acct.status, type: acct.type };
        if (config.twilio_primary_profile_sid) {
          const p = await tw(cred, `${TRUST}/CustomerProfiles/${config.twilio_primary_profile_sid}`);
          status.primary_profile = { name: p.friendly_name, status: p.status };
        }
      } catch (e) { status.error = (e as Error).message; }
    }
    // Agents' subaccount registrations fail with 22216/22217 until Twilio classifies the Primary profile as ISV/Reseller.
    const blocked = (await E.A2PRegistration.filter({ provider_step: 'platform_wait' }, { limit: 20, fields: ['agent_email'] })).items;
    status.isv_blocked = blocked.map((r: any) => r.agent_email);
    const accounts = (await E.TwilioAccount.filter({}, { sort: '-created_at', limit: 100 })).items.map((a: any) => ({ agent_email: a.agent_email, subaccount_sid: a.subaccount_sid, friendly_name: a.friendly_name, source: a.source }));
    if (input.record === true) await E.EngineCursor.upsert([{ key: 'twilio_check', cursor: JSON.stringify({ at: new Date().toISOString(), credentials: status.credentials, account: status.account, primary_profile: status.primary_profile, error: status.error }).slice(0, 1000) }], { key: 'key' });
    const ready = status.credentials && status.account?.status === 'active' && status.account?.type !== 'Trial' && status.primary_profile?.status === 'twilio-approved' && !!(config.twilio_isv_email || config.owner_email);
    return Response.json({
      status, ready, accounts,
      settings: { a2p_provider: config.a2p_provider || 'manual', twilio_primary_profile_sid: config.twilio_primary_profile_sid || '', twilio_isv_email: config.twilio_isv_email || '' },
    });
  } catch (e) { return failure(e as Error); }
}
