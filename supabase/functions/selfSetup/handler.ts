// Self-serve onboarding for any signed-in agent: save brand and business
// details, then build their own GHL workspace in the background.
import { raise } from '../_shared/signals.ts';
import { context, failure } from '../_shared/ghl.ts';
import { STEPS, STEP_LABELS } from '../_shared/provisionCore.ts';
import { agencyOAuthToken } from '../_shared/ghlAuth.ts';
import { profileGaps as missing, startBuild } from '../_shared/approval.ts';

const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const TEXT = ['first_name', 'last_name', 'display_name', 'brand_name', 'legal_business_name', 'agent_title', 'npn', 'address_street', 'address_city', 'address_state', 'address_zip', 'business_email', 'business_phone', 'alert_mobile', 'home_timezone', 'primary_color', 'accent_color', 'logo_url', 'preferred_area_code', 'domain'];

function clean(input: any) {
  const u: Record<string, any> = {};
  for (const k of TEXT) if (input[k] !== undefined) { if (typeof input[k] !== 'string' || input[k].length > (k === 'logo_url' ? 2000 : 200)) throw new Error(`Check the ${k.replaceAll('_', ' ')}.`); u[k] = input[k].trim(); }
  const phone = (v: string) => { const d = v.replace(/[^\d+]/g, ''); const e = d.startsWith('+') ? d : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : d; if (!/^\+[1-9]\d{9,14}$/.test(e)) throw new Error('Enter phone numbers with area code, like (918) 555-0142.'); return e; };
  for (const k of ['business_phone', 'alert_mobile']) if (u[k]) u[k] = phone(u[k]);
  if (u.business_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.business_email)) throw new Error('Enter a valid business email.');
  if (u.address_state) { u.address_state = u.address_state.toUpperCase(); if (!STATES.includes(u.address_state)) throw new Error('Use a two-letter state, like OK.'); }
  if (u.address_zip && !/^\d{5}(-\d{4})?$/.test(u.address_zip)) throw new Error('Enter a 5-digit ZIP code.');
  if (u.npn && !/^\d{4,10}$/.test(u.npn)) throw new Error('Your NPN is 4 to 10 digits.');
  if (u.preferred_area_code && !/^[2-9]\d{2}$/.test(u.preferred_area_code)) throw new Error('Area codes are 3 digits.');
  for (const k of ['primary_color', 'accent_color']) if (u[k] && !/^#[\da-fA-F]{6}$/.test(u[k])) throw new Error('Pick a color from the color picker.');
  if (u.home_timezone) new Intl.DateTimeFormat('en-US', { timeZone: u.home_timezone }).format();
  if (u.domain) { u.domain = u.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.domain)) throw new Error('Enter your website as a domain, like pipkingroup.com.'); }
  if (input.licensed_states !== undefined) { if (!Array.isArray(input.licensed_states) || input.licensed_states.length > 60 || input.licensed_states.some((v: any) => !STATES.includes(v))) throw new Error('Choose your licensed states.'); u.licensed_states = input.licensed_states; }
  if (input.products_offered !== undefined) { if (!Array.isArray(input.products_offered) || input.products_offered.some((v: any) => typeof v !== 'string' || v.length > 40)) throw new Error('Choose your products.'); u.products_offered = input.products_offered; u.products = input.products_offered; }
  if (u.legal_business_name) u.agency_name = u.legal_business_name;
  if (u.first_name && !u.display_name) u.display_name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  if (u.address_street || u.address_city) u.business_address = [u.address_street, u.address_city, [u.address_state, u.address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return u;
}

function view(s: any, config: any, connected: boolean) {
  const p = s.provisioning || {};
  const gated = config.self_serve_requires_approval === true && !s.beta_access && !s.location_id;
  return {
    profile: Object.fromEntries([...TEXT, 'licensed_states', 'products_offered'].map(k => [k, s[k] ?? (k === 'licensed_states' || k === 'products_offered' ? [] : '')])),
    missing: missing(s),
    workspace_ready: p.state === 'done' || (!!s.location_id && s.connected && !s.self_serve),
    provisioning: { state: gated ? 'awaiting_approval' : (p.state || 'not_started'), current: p.current || '', error: p.error || '', steps: STEPS.map(k => ({ key: k, label: STEP_LABELS[k], status: p.steps?.[k] || 'pending' })) },
    platform_connected: connected,
    approval: gated ? 'pending' : (config.self_serve_requires_approval === true && s.beta_access && !s.location_id ? 'approved' : 'none'),
  };
}

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    const input = await req.json();
    const E = base44.asServiceRole.entities;
    // Read platform settings with the service role: agents cannot read them directly.
    const config = (await E.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 })).items[0];
    if (!config?.agency_company_id) throw new Error('The platform is not configured yet. Contact the administrator.');
    let s = (await E.AgentSettings.filter({ agent_email: user.email }, { limit: 1 })).items[0];
    if (!s) {
      if (config.self_serve_enabled === false && user.role !== 'admin') throw new Error('New signups are paused. Contact the platform administrator.');
      const first = String(user.full_name || '').split(' ')[0] || '';
      s = await E.AgentSettings.create({ agent_email: user.email, first_name: first, display_name: user.full_name || first, notification_email: user.email, business_email: user.email, status: 'onboarding', mode: 'review', self_serve: true, onboarding_step: 1 });
    }
    const connected = !!(await agencyOAuthToken(base44).catch(() => null));
    if (config.self_serve_requires_approval === true && !s.beta_access && !s.location_id) {
      const who = [s.first_name, s.last_name].filter(Boolean).join(' ') || s.agent_email;
      await raise(base44, { key: `signup_approval:${s.agent_email}`, kind: 'signup_approval', severity: 'warning', scope: 'platform', agent_email: s.agent_email, notifyOwner: true,
        title: `New signup waiting for approval: ${s.brand_name || who}`, detail: `${who} (${s.agent_email}) signed up. Approve them on Admin > Agents so they can create their workspace.`, action_label: 'Review', action_href: '/admin' }).catch(() => {});
    }

    if (input.action === 'save_profile') {
      const update = clean(input.profile || {});
      s = await E.AgentSettings.update(s.id, update);
    }

    if (input.action === 'build') {
      const gaps = missing(s);
      if (gaps.length) throw new Error(`Add your ${gaps.join(', ')} first.`);
      if (config.self_serve_requires_approval === true && !s.beta_access && !s.location_id) {
        return Response.json(view(s, config, connected));
      }
      // Same entry point Admin approval uses, so a build started either way behaves identically.
      await startBuild(base44, s, config);
    }
    s = (await E.AgentSettings.filter({ agent_email: user.email }, { limit: 1 })).items[0];
    return Response.json(view(s, config, connected));
  } catch (error) { return failure(error as Error); }
}
