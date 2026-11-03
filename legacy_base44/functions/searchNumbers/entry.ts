import { setupContext, configFor } from '../../shared/setupAccess.ts';
import { agentSettings, failure } from '../../shared/ghl.ts';
import { phoneRequest, phoneRows } from '../../shared/numberProvisioning.ts';
import { twilioConfigured, ensureSubaccount, subCred, tw, API } from '../../shared/twilio.ts';

export default async function (req: Request) {
  try {
    const ctx = await setupContext(req); let { s } = ctx; const { E, user, base44 } = ctx;
    const input = await req.json();
    if (input.agent_email) { if (user.role !== 'admin') throw new Error('Access denied.'); s = await agentSettings(base44, String(input.agent_email)); if (!s) throw new Error('Agent not found.'); }
    const area = String(input.area_code || s.preferred_area_code || '');
    if (!/^[2-9]\d{2}$/.test(area)) throw new Error('Enter a valid US three-digit area code.');
    const c = await configFor(E);

    if (c.a2p_provider === 'twilio' && twilioConfigured()) {
      const cred = await subCred(await ensureSubaccount(E, s));
      const data = await tw(cred, `${API}/Accounts/${cred.sid}/AvailablePhoneNumbers/US/Local.json`, { AreaCode: area, SmsEnabled: 'true', VoiceEnabled: 'true', ExcludeAllAddressRequired: 'true', PageSize: 20 }, 'GET');
      const numbers = (data.available_phone_numbers || []).map((n: any) => ({ phone_number: n.phone_number, friendly_name: `${n.friendly_name}${n.locality ? ` · ${n.locality}, ${n.region}` : ''}` }));
      return Response.json({ numbers, manual: false, message: numbers.length ? '' : 'No numbers in that area code right now. Try a nearby one.' });
    }

    const query = new URLSearchParams({ firstPart: area, lastPart: '', anywhere: '', numberTypes: 'local', smsEnabled: 'true', mmsEnabled: 'false', voiceEnabled: 'true', countryCode: 'US' });
    const result = await phoneRequest(E, s, `/phone-system/numbers/location/${encodeURIComponent(s.location_id)}/available?${query}`);
    const rows = phoneRows(result.body);
    const numbers = (rows || []).slice(0, 20).map((n: any) => ({ phone_number: n.phoneNumber || n.phone_number, friendly_name: n.friendlyName || n.friendly_name || n.phoneNumber || n.phone_number })).filter((n: any) => /^\+1\d{10}$/.test(n.phone_number || ''));
    return Response.json({ numbers, manual: !result.ok || !rows, provider_status: result.status, message: !result.ok || !rows ? 'Number search needs administrator assistance. You can send a number request below.' : '', ...(user.role === 'admin' ? { provider_response: result.body } : {}) });
  } catch (e) { return failure(e as Error); }
}
