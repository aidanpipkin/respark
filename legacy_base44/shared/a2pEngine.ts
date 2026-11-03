// Registers an agent's A2P 10DLC brand and campaign with Twilio and follows it to approval.
// Standard brands (agent has an EIN) and Sole Proprietor brands (no EIN) are both supported.
// The EIN is passed straight to Twilio and never stored.
import { extraSamples, recommendedProgram } from './a2pProgram.ts';
import { tw, subCred, ensureSubaccount, evaluationProblems, API, TRUST, MSG } from './twilio.ts';

const POLICY = {
  secondaryProfile: 'RNdfbf3fae0e1107f8aded0e7cead80bf5',
  standardTrust: 'RNb0d4771c2c98518d916a3d4cd70a8f8b',
  starterProfile: 'RN806dd6cd175f314e1f96a9727ee271f4',
  soleTrust: 'RN670d5d2e282a6130ae063b234b6019c8',
};

const now = () => new Date().toISOString();

/** The platform's own Twilio ISV setup is incomplete; nothing the agent entered is wrong. */
export class PlatformNotReady extends Error {
  constructor() { super('Waiting on a one-time carrier setup on our side.'); this.name = 'PlatformNotReady'; }
}

// ---- Platform readiness: can agent subaccounts register under our Primary Customer Profile? ----
const PLATFORM_KEY = 'a2p_platform';

export async function platformState(E: any): Promise<{ ready: boolean | null; at: string }> {
  const row = (await E.EngineCursor.filter({ key: PLATFORM_KEY }, { limit: 1 })).items[0];
  try { return JSON.parse(row?.cursor || ''); } catch { return { ready: null, at: '' }; }
}
async function savePlatformState(E: any, ready: boolean) {
  await E.EngineCursor.upsert([{ key: PLATFORM_KEY, cursor: JSON.stringify({ ready, at: now() }) }], { key: 'key' });
}

/**
 * Non-destructive probe: builds an empty secondary profile in a subaccount, attaches our Primary
 * profile, evaluates only that requirement, then deletes the draft. Nothing is submitted.
 */
export async function probePlatform(E: any, config: any, subSid: string) {
  const cred = await subCred(subSid);
  const p = await tw(cred, `${TRUST}/CustomerProfiles`, { FriendlyName: 'LeadRespark readiness check', Email: config.twilio_isv_email || config.owner_email, PolicySid: POLICY.secondaryProfile });
  try {
    await assign(cred, 'CustomerProfiles', p.sid, config.twilio_primary_profile_sid).catch(() => {});
    const ev = await tw(cred, `${TRUST}/CustomerProfiles/${p.sid}/Evaluations`, { PolicySid: POLICY.secondaryProfile });
    const primary = (ev.results || []).find((r: any) => /primary_customer_profile/.test(String(r.requirement_name || r.object_type || '')));
    const ready = !!primary && primary.passed === true;
    await savePlatformState(E, ready);
    return ready;
  } finally {
    await tw(cred, `${TRUST}/CustomerProfiles/${p.sid}`, undefined, 'DELETE').catch(() => {});
  }
}

export async function markPlatform(E: any, ready: boolean) { await savePlatformState(E, ready); }

async function assign(cred: any, kind: 'CustomerProfiles' | 'TrustProducts', bundle: string, objectSid: string) {
  await tw(cred, `${TRUST}/${kind}/${bundle}/EntityAssignments`, { ObjectSid: objectSid });
}

/** Bundle statuses that mean "keep using this SID" when a submit is retried. */
const REUSABLE = ['draft', 'pending-review', 'in-review', 'twilio-approved'];

/**
 * Resumable bundle: when a previous attempt already created this Customer Profile / Trust Product (its SID is
 * saved on the registration), reuse it instead of creating a second one. A rejected or missing bundle is
 * deleted and recreated. Returns the SID plus whether its contents still need to be assigned and submitted.
 */
async function ensureBundle(E: any, cred: any, reg: any, field: 'customer_profile_sid' | 'trust_product_sid', kind: 'CustomerProfiles' | 'TrustProducts', create: Record<string, any>) {
  const saved = String(reg[field] || '').trim();
  if (saved) {
    const existing = await tw(cred, `${TRUST}/${kind}/${saved}`).catch(() => null);
    const status = String(existing?.status || '');
    if (existing && REUSABLE.includes(status)) return { sid: saved, build: status === 'draft' };
    // twilio-rejected, deleted or unreadable: start that bundle over.
    if (existing) await tw(cred, `${TRUST}/${kind}/${saved}`, undefined, 'DELETE').catch(() => {});
    await E.A2PRegistration.update(reg.id, { [field]: '' });
    reg[field] = '';
  }
  const made = await tw(cred, `${TRUST}/${kind}`, create);
  // Persist immediately so a timeout after this point resumes here instead of creating another bundle.
  await E.A2PRegistration.update(reg.id, { [field]: made.sid });
  reg[field] = made.sid;
  return { sid: made.sid as string, build: true };
}

/** EntityAssignments on a reused draft may already exist; Twilio answers 400/409 for duplicates, which is fine. */
async function assignSoft(cred: any, kind: 'CustomerProfiles' | 'TrustProducts', bundle: string, objectSid: string) {
  try { await assign(cred, kind, bundle, objectSid); }
  catch (e: any) { if (![400, 409].includes(Number(e?.status))) throw e; }
}

async function evaluateAndSubmit(cred: any, kind: 'CustomerProfiles' | 'TrustProducts', bundle: string, policy: string, label: string, onDelete?: () => Promise<void>) {
  const ev = await tw(cred, `${TRUST}/${kind}/${bundle}/Evaluations`, { PolicySid: policy });
  const problems = evaluationProblems(ev);
  if (problems.length) {
    // Remove the half-built draft so retries don't pile up bundles in the subaccount.
    await tw(cred, `${TRUST}/${kind}/${bundle}`, undefined, 'DELETE').catch(() => {});
    if (onDelete) await onDelete().catch(() => {});
    const platformSide = (ev?.results || []).some((r: any) => r.passed === false && /primary_customer_profile/.test(String(r.requirement_name || r.object_type || '')));
    if (platformSide && problems.length === 1) throw new PlatformNotReady();
    throw new Error(`${label} needs fixes: ${problems.join(' | ')}`);
  }
  await tw(cred, `${TRUST}/${kind}/${bundle}`, { Status: 'pending-review' });
}

async function address(cred: any, reg: any, name: string) {
  const a = await tw(cred, `${API}/Accounts/${cred.sid}/Addresses.json`, { CustomerName: name, Street: reg.street, City: reg.city, Region: reg.region, PostalCode: reg.postal_code, IsoCountry: 'US', FriendlyName: `${name} address`.slice(0, 64) });
  const doc = await tw(cred, `${TRUST}/SupportingDocuments`, { FriendlyName: `${name} address`.slice(0, 64), Type: 'customer_profile_address', Attributes: { address_sids: a.sid } });
  return doc.sid as string;
}

/**
 * Creates the compliance bundles and brand. Runs while the agent waits, because the EIN
 * only exists in this request. Saves the SIDs and returns the updated registration.
 */
export async function submitToTwilio(E: any, s: any, config: any, reg: any, ein: string) {
  if (!config.twilio_primary_profile_sid) throw new Error('Texting registration is not set up yet. Contact your administrator.');
  const isvEmail = config.twilio_isv_email || config.owner_email;
  const subSid = reg.twilio_subaccount_sid || await ensureSubaccount(E, s);
  const cred = await subCred(subSid);
  const sole = reg.business_type === 'sole_proprietor';
  const label = sole ? `${reg.first_name} ${reg.last_name}` : reg.legal_business_name;
  // customer_profile_sid / trust_product_sid / brand_sid are kept: a retry resumes from whatever already exists.
  await E.A2PRegistration.update(reg.id, { twilio_subaccount_sid: subSid, provider_step: 'profile', review_note: '' });
  reg = { ...reg, twilio_subaccount_sid: subSid };
  const forget = (field: 'customer_profile_sid' | 'trust_product_sid') => async () => { await E.A2PRegistration.update(reg.id, { [field]: '' }); reg[field] = ''; };

  let profileSid: string, trustSid: string;
  if (sole) {
    const profile = await ensureBundle(E, cred, reg, 'customer_profile_sid', 'CustomerProfiles', { FriendlyName: `${label} starter profile`.slice(0, 64), Email: isvEmail, PolicySid: POLICY.starterProfile });
    profileSid = profile.sid;
    if (profile.build) {
      const person = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: label.slice(0, 64), Type: 'starter_customer_profile_information', Attributes: { email: reg.business_email, first_name: reg.first_name, last_name: reg.last_name, phone_number: reg.mobile_phone } });
      await assignSoft(cred, 'CustomerProfiles', profileSid, person.sid);
      await assignSoft(cred, 'CustomerProfiles', profileSid, await address(cred, reg, label));
      await assignSoft(cred, 'CustomerProfiles', profileSid, config.twilio_primary_profile_sid);
      await evaluateAndSubmit(cred, 'CustomerProfiles', profileSid, POLICY.starterProfile, 'Your profile', forget('customer_profile_sid'));
    }

    const trust = await ensureBundle(E, cred, reg, 'trust_product_sid', 'TrustProducts', { FriendlyName: `${label} sole proprietor`.slice(0, 64), Email: isvEmail, PolicySid: POLICY.soleTrust });
    trustSid = trust.sid;
    if (trust.build) {
      const info = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: `${label} brand`.slice(0, 64), Type: 'sole_proprietor_information', Attributes: { brand_name: reg.legal_business_name || label, mobile_phone_number: reg.mobile_phone } });
      await assignSoft(cred, 'TrustProducts', trustSid, info.sid);
      await assignSoft(cred, 'TrustProducts', trustSid, profileSid);
      await evaluateAndSubmit(cred, 'TrustProducts', trustSid, POLICY.soleTrust, 'Your texting profile', forget('trust_product_sid'));
    }
  } else {
    const profile = await ensureBundle(E, cred, reg, 'customer_profile_sid', 'CustomerProfiles', { FriendlyName: `${label} profile`.slice(0, 64), Email: isvEmail, PolicySid: POLICY.secondaryProfile });
    profileSid = profile.sid;
    if (profile.build) {
      const business = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: label.slice(0, 64), Type: 'customer_profile_business_information', Attributes: {
        business_name: reg.legal_business_name, business_identity: 'direct_customer', business_industry: 'INSURANCE', business_regions_of_operation: 'USA_AND_CANADA',
        business_registration_identifier: 'EIN', business_registration_number: ein, business_type: reg.entity_type, website_url: reg.website,
      } });
      await assignSoft(cred, 'CustomerProfiles', profileSid, business.sid);
      const rep = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: `${reg.first_name} ${reg.last_name}`.slice(0, 64), Type: 'authorized_representative_1', Attributes: {
        business_title: reg.rep_title || 'Owner', email: reg.business_email, first_name: reg.first_name, last_name: reg.last_name, job_position: reg.rep_position || 'Director', phone_number: reg.business_phone,
      } });
      await assignSoft(cred, 'CustomerProfiles', profileSid, rep.sid);
      await assignSoft(cred, 'CustomerProfiles', profileSid, await address(cred, reg, label));
      await assignSoft(cred, 'CustomerProfiles', profileSid, config.twilio_primary_profile_sid);
      await evaluateAndSubmit(cred, 'CustomerProfiles', profileSid, POLICY.secondaryProfile, 'Your business profile', forget('customer_profile_sid'));
    }

    const trust = await ensureBundle(E, cred, reg, 'trust_product_sid', 'TrustProducts', { FriendlyName: `${label} A2P profile`.slice(0, 64), Email: isvEmail, PolicySid: POLICY.standardTrust });
    trustSid = trust.sid;
    if (trust.build) {
      const info = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: `${label} messaging`.slice(0, 64), Type: 'us_a2p_messaging_profile_information', Attributes: { company_type: reg.entity_type === 'Non-profit Corporation' ? 'non-profit' : 'private' } });
      await assignSoft(cred, 'TrustProducts', trustSid, info.sid);
      await assignSoft(cred, 'TrustProducts', trustSid, profileSid);
      await evaluateAndSubmit(cred, 'TrustProducts', trustSid, POLICY.standardTrust, 'Your texting profile', forget('trust_product_sid'));
    }
  }

  // One brand per registration, ever: a saved brand_sid is re-read, never re-registered (each registration is billed).
  const brand = reg.brand_sid
    ? await tw(cred, `${MSG}/a2p/BrandRegistrations/${reg.brand_sid}`)
    : await tw(cred, `${MSG}/a2p/BrandRegistrations`, { CustomerProfileBundleSid: profileSid, A2PProfileBundleSid: trustSid, ...(sole ? { BrandType: 'SOLE_PROPRIETOR' } : {}) });
  if (!reg.brand_sid) await E.A2PRegistration.update(reg.id, { brand_sid: brand.sid });
  return await E.A2PRegistration.update(reg.id, {
    customer_profile_sid: profileSid, trust_product_sid: trustSid, brand_sid: brand.sid, brand_status: brand.status || 'PENDING', identity_status: brand.identity_status || '',
    status: 'brand_submitted', provider_step: 'brand', submitted_at: now(), last_checked_at: now(), review_note: sole ? 'Brand submitted. Watch your mobile phone for a verification text and reply YES.' : 'Brand submitted to the carriers. This usually takes 1 to 3 business days, then the campaign review 1 to 7.',
  });
}

function campaignDescription(reg: any, s: any) {
  // What the agent reviewed is what the carriers get. No identifiers are appended: reviewers reject
  // descriptions carrying NPNs or other personal data (Twilio error 30886).
  const base = String(reg.description || '').trim();
  const text = base.length >= 40 ? base : recommendedProgram({ ...reg, dba: s?.brand_name || '' }).description;
  return text.slice(0, 4096);
}

function campaignSamples(reg: any) {
  return [...new Set([reg.sample_message_1, reg.sample_message_2, ...extraSamples(reg)].filter(Boolean).map((m: string) => m.slice(0, 1024)))].slice(0, 5);
}

/**
 * A campaign the carriers sent back is fixed on the approved brand, never by registering the brand again.
 * Twilio lets the failed campaign be edited in place; accounts without that feature replace it on the same brand.
 */
export async function resubmitCampaign(E: any, s: any, reg: any) {
  if (!reg?.brand_sid || !reg.messaging_service_sid || !reg.campaign_sid || !reg.twilio_subaccount_sid) throw new Error('There is no campaign to resubmit yet.');
  const cred = await subCred(reg.twilio_subaccount_sid);
  const mg = reg.messaging_service_sid;
  const sole = reg.business_type === 'sole_proprietor';
  const edit = {
    Description: campaignDescription(reg, s), MessageFlow: String(reg.opt_in_flow).slice(0, 2048), MessageSamples: campaignSamples(reg),
    HasEmbeddedLinks: 'false', HasEmbeddedPhone: 'false', AgeGated: 'false', DirectLending: 'false',
    PrivacyPolicyUrl: reg.privacy_url, TermsAndConditionsUrl: reg.terms_url,
  };
  let campaign: any, how = 'updated';
  // A campaign the carriers are reviewing right now cannot be edited or replaced; the new wording waits for their verdict.
  const current = await tw(cred, `${MSG}/Services/${mg}/Compliance/Usa2p/${reg.campaign_sid}`).catch(() => null);
  if (current && ['IN_PROGRESS', 'PENDING'].includes(String(current.campaign_status))) {
    const e: any = new Error('The carriers are reviewing this campaign right now, so it cannot be changed until they answer. Your updated wording is saved and will be used if they send it back.');
    e.name = 'CampaignInReview'; throw e;
  }
  try {
    campaign = await tw(cred, `${MSG}/Services/${mg}/Compliance/Usa2p/${reg.campaign_sid}`, edit);
  } catch (e) {
    console.warn('A2P campaign edit unavailable, replacing campaign', reg.agent_email, (e as Error).message);
    await tw(cred, `${MSG}/Services/${mg}/Compliance/Usa2p/${reg.campaign_sid}`, undefined, 'DELETE').catch(() => {});
    campaign = await tw(cred, `${MSG}/Services/${mg}/Compliance/Usa2p`, {
      BrandRegistrationSid: reg.brand_sid, ...edit, UsAppToPersonUsecase: sole ? 'SOLE_PROPRIETOR' : 'MARKETING',
      OptOutMessage: reg.stop_response, HelpMessage: reg.help_response, OptOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'], HelpKeywords: ['HELP', 'INFO'],
    });
    how = 'replaced';
  }
  const update = {
    campaign_sid: campaign.sid || reg.campaign_sid, campaign_status: campaign.campaign_status || 'IN_PROGRESS', status: 'campaign_submitted', provider_step: 'campaign',
    resubmit_requested: false, resubmitted_at: now(), last_checked_at: now(),
    review_note: 'Your texting campaign was resubmitted to the carriers with updated program details. Review usually takes 1 to 7 business days. Your business verification stays approved.',
  };
  await E.AgentSettings.update(s.id, { a2p_status: 'campaign_submitted' });
  return { reg: await E.A2PRegistration.update(reg.id, update), how };
}

/** Follows a submitted registration forward. Safe to call repeatedly. */
export async function advanceRegistration(E: any, s: any, reg: any) {
  if (!reg?.brand_sid || !reg.twilio_subaccount_sid || reg.status === 'approved' || reg.status === 'rejected') return reg;
  const cred = await subCred(reg.twilio_subaccount_sid);
  const sole = reg.business_type === 'sole_proprietor';
  const update: Record<string, any> = { last_checked_at: now() };

  if (!reg.campaign_sid) {
    const brand = await tw(cred, `${MSG}/a2p/BrandRegistrations/${reg.brand_sid}`);
    update.brand_status = brand.status; update.identity_status = brand.identity_status || '';
    if (['FAILED', 'SUSPENDED', 'DELETED'].includes(brand.status)) {
      Object.assign(update, { status: 'rejected', provider_step: 'brand', review_note: `The carriers did not approve the brand${brand.failure_reason ? `: ${brand.failure_reason}` : '.'} Update your details and submit again.` });
      return await E.A2PRegistration.update(reg.id, update);
    }
    if (brand.status !== 'APPROVED') return await E.A2PRegistration.update(reg.id, { ...update, review_note: 'Brand is in carrier review. This usually takes 1 to 3 business days, then the campaign review 1 to 7.' });
    if (sole && brand.identity_status !== 'VERIFIED') {
      return await E.A2PRegistration.update(reg.id, { ...update, status: 'otp_pending', provider_step: 'otp', review_note: `Check your mobile phone (${String(reg.mobile_phone).slice(-4).padStart(4, '•')}) for a text from the carrier and reply YES. You can resend it below.` });
    }
    // Brand approved: messaging service + campaign.
    let mg = reg.messaging_service_sid;
    if (!mg) {
      const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
      const svc = await tw(cred, `${MSG}/Services`, { FriendlyName: `${reg.legal_business_name || s.brand_name || 'Respark'} A2P`.slice(0, 64), UseInboundWebhookOnNumber: 'true', ...(acct?.webhook_url ? { StatusCallback: acct.webhook_url } : {}) });
      mg = svc.sid; update.messaging_service_sid = mg;
    }
    const samples = campaignSamples(reg);
    const campaign = await tw(cred, `${MSG}/Services/${mg}/Compliance/Usa2p`, {
      BrandRegistrationSid: reg.brand_sid, Description: campaignDescription(reg, s), MessageFlow: String(reg.opt_in_flow).slice(0, 2048), MessageSamples: samples,
      UsAppToPersonUsecase: sole ? 'SOLE_PROPRIETOR' : 'MARKETING', HasEmbeddedLinks: 'false', HasEmbeddedPhone: 'false',
      PrivacyPolicyUrl: reg.privacy_url, TermsAndConditionsUrl: reg.terms_url,
      OptOutMessage: reg.stop_response, HelpMessage: reg.help_response, OptOutKeywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'], HelpKeywords: ['HELP', 'INFO'],
    });
    Object.assign(update, { campaign_sid: campaign.sid, campaign_status: campaign.campaign_status || 'IN_PROGRESS', status: 'campaign_submitted', provider_step: 'campaign', review_note: 'Brand approved. Your texting campaign is in carrier review, usually 1 to 7 business days.' });
    reg = { ...reg, ...update };
  }

  // Attach the agent's number to the messaging service as soon as both exist.
  if (reg.messaging_service_sid && s.phone_number && reg.number_attached !== s.phone_number) {
    const nums = await tw(cred, `${API}/Accounts/${cred.sid}/IncomingPhoneNumbers.json`, { PhoneNumber: s.phone_number }, 'GET');
    const pn = (nums.incoming_phone_numbers || [])[0];
    if (pn) {
      try { await tw(cred, `${MSG}/Services/${reg.messaging_service_sid}/PhoneNumbers`, { PhoneNumberSid: pn.sid }); }
      catch (e: any) { if (e?.code !== 21710) throw e; /* already in the service */ }
      update.number_attached = s.phone_number;
    }
  }

  if (reg.campaign_sid) {
    const c = await tw(cred, `${MSG}/Services/${reg.messaging_service_sid}/Compliance/Usa2p/${reg.campaign_sid}`);
    update.campaign_status = c.campaign_status;
    if (c.campaign_status === 'VERIFIED') {
      Object.assign(update, { status: 'approved', provider_step: 'done', approved_at: now(), review_note: update.number_attached || reg.number_attached ? 'Approved. Your number is registered for texting.' : 'Approved. Your number will be registered as soon as it is assigned.' });
      await E.AgentSettings.update(s.id, { a2p_status: 'approved' });
    } else if (c.campaign_status === 'FAILED') {
      const errs = (c.errors || []).map((x: any) => x.description || x.error_code).filter(Boolean).join('; ');
      // Right after an in-place resubmit Twilio can still report the previous FAILED verdict for a while. The same
      // error text inside three hours of resubmitting is that stale verdict, not a new review.
      const sinceResubmit = reg.resubmitted_at ? Date.now() - Date.parse(reg.resubmitted_at) : Infinity;
      const sameAsBefore = !!errs && String(reg.last_rejection || '') === errs;
      if (sinceResubmit < 3 * 3600000 && sameAsBefore) {
        Object.assign(update, { review_note: 'Resubmitted. Waiting for the carriers to review the updated campaign (usually 1 to 7 business days).' });
      } else {
        Object.assign(update, { status: 'rejected', last_rejection: errs, review_note: `The carriers did not approve the campaign${errs ? `: ${errs}` : '.'} Update your program details and submit again.` });
        await E.AgentSettings.update(s.id, { a2p_status: 'rejected' });
      }
    }
  }
  return await E.A2PRegistration.update(reg.id, update);
}

/** Sole Proprietor: resend the YES verification text to the agent's mobile. */
export async function resendOtp(reg: any) {
  if (reg?.business_type !== 'sole_proprietor' || !reg.brand_sid) throw new Error('Nothing to verify.');
  const cred = await subCred(reg.twilio_subaccount_sid);
  await tw(cred, `${MSG}/a2p/BrandRegistrations/${reg.brand_sid}/SmsOtp`, {});
}
