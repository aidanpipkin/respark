// Agent's registration status: refresh from the carriers, or resend the Sole Proprietor verification text.
import { setupContext } from '../../shared/setupAccess.ts';
import { advanceRegistration, resendOtp } from '../../shared/a2pEngine.ts';
import { failure } from '../../shared/ghl.ts';

const PUBLIC = ['business_type', 'legal_business_name', 'status', 'review_note', 'provider_step', 'brand_status', 'identity_status', 'campaign_status', 'submitted_at', 'approved_at', 'last_checked_at', 'ein_last4'];

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    let reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    if (reg && input.action === 'refresh' && reg.brand_sid) {
      if (Date.now() - Date.parse(reg.last_checked_at || 0) > 30000) reg = await advanceRegistration(E, s, reg);
    }
    if (reg && input.action === 'resend_otp') {
      if (reg.status !== 'otp_pending' && !(reg.status === 'brand_submitted' && reg.business_type === 'sole_proprietor')) throw new Error('There is no verification text to resend.');
      await resendOtp(reg);
      reg = await E.A2PRegistration.update(reg.id, { review_note: `Verification text resent to the mobile ending ${String(reg.mobile_phone || '').slice(-4)}. Reply YES within 24 hours.` });
    }
    return Response.json({ registration: reg ? Object.fromEntries(PUBLIC.map(k => [k, reg[k] ?? ''])) : null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e as Error); }
}
