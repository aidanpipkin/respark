const FREQS = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['semi_annual', 'Every 6 months'], ['annual', 'Annually']];
export const EMPTY_POLICY = { carrier: '', product: '', policy_number: '', coverage_amount: '', premium_amount: '', premium_frequency: 'monthly', coverage_start_date: '', first_draft_date: '', beneficiary: '', notes: '' };

export function missingPolicy(p) {
  const miss = [];
  if (!p.carrier?.trim()) miss.push('carrier');
  if (!p.product?.trim()) miss.push('product');
  if (!p.policy_number?.trim()) miss.push('policy number');
  if (!(Number(String(p.coverage_amount).replace(/[$,]/g, '')) > 0)) miss.push('coverage amount');
  if (!(Number(String(p.premium_amount).replace(/[$,]/g, '')) > 0)) miss.push('premium amount');
  if (!p.coverage_start_date) miss.push('coverage start date');
  if (!p.first_draft_date) miss.push('first premium draft date');
  return miss;
}

/** Required policy details. The AI and the client texts use exactly what is entered here. */
export default function PolicyForm({ value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const field = (k, label, { optional, ...props } = {}) => <label className="block"><span className="field-label">{label}{optional ? '' : ' *'}</span><input className="field" value={value[k] ?? ''} onChange={e => set(k, e.target.value)} {...props} /></label>;
  return <div className="grid gap-3 sm:grid-cols-2">
    {field('carrier', 'Carrier', { placeholder: 'e.g. Mutual of Omaha', maxLength: 120 })}
    {field('product', 'Product', { placeholder: 'e.g. IUL, 20-year term', maxLength: 120 })}
    {field('policy_number', 'Policy number', { maxLength: 60 })}
    {field('coverage_amount', 'Coverage amount ($)', { inputMode: 'decimal', placeholder: '250000' })}
    {field('premium_amount', 'Premium amount ($)', { inputMode: 'decimal', placeholder: '85.40' })}
    <label className="block"><span className="field-label">Premium frequency *</span><select className="field" value={value.premium_frequency} onChange={e => set('premium_frequency', e.target.value)}>{FREQS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    {field('coverage_start_date', 'Coverage start date', { type: 'date' })}
    {field('first_draft_date', 'First premium draft date', { type: 'date' })}
    {field('beneficiary', 'Beneficiary (optional)', { optional: true, maxLength: 120 })}
    <label className="block sm:col-span-2"><span className="field-label">Notes (optional)</span><textarea className="field min-h-16" maxLength={1000} value={value.notes ?? ''} onChange={e => set('notes', e.target.value)} placeholder="Riders, underwriting class, anything you'll want to remember. No SSNs." /></label>
  </div>;
}
