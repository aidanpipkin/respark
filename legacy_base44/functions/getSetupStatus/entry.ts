import { setupContext, configFor } from '../../shared/setupAccess.ts';
import { billingAccount, cardSummary } from '../../shared/stripeRest.ts';
import { failure } from '../../shared/ghl.ts';
import { exempt } from '../../shared/credits.ts';
import { recommendedProgram, extraSamples } from '../../shared/a2pProgram.ts';
import { twilioConfigured } from '../../shared/twilio.ts';
import { ensurePublicSlug, appOrigin, siteLinks, hostedOptInFlow } from '../../shared/agentSite.ts';

const REG_FIELDS = ['status', 'review_note', 'provider_step', 'brand_status', 'identity_status', 'campaign_status', 'submitted_at', 'approved_at', 'last_checked_at', 'ein_last4', 'legal_business_name', 'business_type', 'entity_type', 'first_name', 'last_name', 'npn', 'rep_title', 'rep_position', 'mobile_phone', 'business_email', 'business_phone', 'street', 'city', 'region', 'postal_code', 'website', 'privacy_url', 'terms_url', 'description', 'opt_in_flow', 'sample_message_1', 'sample_message_2', 'stop_response', 'help_response', 'attested'];

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const [a, c, t, r, k] = await Promise.all([
      billingAccount(E, s.agent_email), configFor(E),
      E.ProvisioningTask.filter({ agent_email: s.agent_email }, { sort: '-created_date', limit: 10, fields: ['kind', 'status', 'requested_number', 'public_note'] }),
      E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1, fields: REG_FIELDS }),
      E.CalendarConnection.filter({ agent_email: s.agent_email, status: 'connected' }, { limit: 1, fields: ['provider', 'status'] }),
    ]);
    const automatic = c.a2p_provider === 'twilio' && twilioConfigured();
    const slug = await ensurePublicSlug(E, s);
    const links = siteLinks(appOrigin(req), slug);
    return Response.json({
      checklist: { billing: a?.status === 'card_saved' || exempt(c, s.agent_email), number: !!s.phone_number, texting: s.a2p_status === 'approved', calendar: !!k.items[0] },
      card: cardSummary(a), phone_number: s.phone_number || '', area_code: s.preferred_area_code || '', tasks: t.items,
      registration: r.items[0] || null, fee_cents: c.phone_number_setup_fee_cents ?? 0, a2p_automatic: automatic,
      site: { ...links, opt_in_flow: hostedOptInFlow(s, links) },
      program: (() => { const base = { legal_business_name: s.legal_business_name || s.brand_name || '', first_name: s.first_name || '', last_name: s.last_name || '', npn: s.npn || '', business_phone: s.business_phone || '', business_email: s.business_email || s.agent_email, licensed_states: s.licensed_states || [], website: r.items[0]?.website || links.url }; return { ...recommendedProgram(base, hostedOptInFlow(s, links), s.brand_name || ''), extra_samples: extraSamples(base) }; })(),
      profile: {
        legal_business_name: s.legal_business_name || s.brand_name || '', brand_name: s.brand_name || '', first_name: s.first_name || '', last_name: s.last_name || '', npn: s.npn || '',
        business_email: s.business_email || s.agent_email, business_phone: s.business_phone || '', alert_mobile: s.alert_mobile || '',
        street: s.address_street || '', city: s.address_city || '', region: s.address_state || '', postal_code: s.address_zip || '',
        business_address: s.business_address || '', website: s.domain ? `https://${s.domain}` : '', display_name: s.first_name || s.display_name || 'your agent',
      },
      calendar: { google_available: false, google_note: 'Administrator calendar authorization is required before Google can be connected.', microsoft_available: false, microsoft_note: 'Microsoft connect opens soon.' },
    });
  } catch (e) { return failure(e as Error); }
}
