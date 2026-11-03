// Admin: the pre-call documents attached to every appointment email (buyer's guide, carrier brochures).
import { adminContext } from '../_shared/agentAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { platformConfig } from '../_shared/credits.ts';
import { BUYERS_GUIDE } from '../_shared/appointmentJourney.ts';

const PRODUCTS = ['all', 'iul', 'final_expense', 'mortgage'];
export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));
    const config = await platformConfig(E);
    let docs: any[] = Array.isArray(config.booking_documents) ? config.booking_documents : [];
    if (!docs.some(d => d.id === BUYERS_GUIDE.id)) docs = [{ ...BUYERS_GUIDE, approved: true, builtin: true }, ...docs];
    if (input.action === 'save') {
      const d = input.document || {};
      const name = String(d.name || '').trim().slice(0, 100);
      if (!name) throw new Error('Name the document.');
      if (!/^https:\/\/\S+$/.test(d.url || '')) throw new Error('Upload the PDF or paste an https link.');
      const products = (Array.isArray(d.products) ? d.products : ['iul']).filter((p: string) => PRODUCTS.includes(p));
      if (d.id !== BUYERS_GUIDE.id && d.approved !== true) throw new Error('Confirm this is a carrier-approved, consumer-facing piece.');
      const doc = { id: d.id || crypto.randomUUID(), name, url: d.url, products: products.length ? products : ['iul'], active: d.active !== false, approved: d.approved === true || d.id === BUYERS_GUIDE.id, note: String(d.note || '').slice(0, 200), updated_at: new Date().toISOString() };
      docs = docs.some(x => x.id === doc.id) ? docs.map(x => x.id === doc.id ? { ...x, ...doc } : x) : [...docs, doc];
      if (docs.length > 20) throw new Error('Keep it to 20 documents or fewer.');
      await E.PlatformSettings.update(config.id, { booking_documents: docs });
    }
    if (input.action === 'remove') {
      if (input.id === BUYERS_GUIDE.id) docs = docs.map(x => x.id === BUYERS_GUIDE.id ? { ...x, active: false } : x);
      else docs = docs.filter(x => x.id !== input.id);
      await E.PlatformSettings.update(config.id, { booking_documents: docs });
    }
    return Response.json({ documents: docs });
  } catch (error) { return failure(error as Error); }
}
