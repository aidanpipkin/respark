import { base44 } from '@/api/base44Client';
function data400(error) { return !!(error?.message && !error.response && !/network|fetch|timeout/i.test(error.message)); }
export async function call(name, payload = {}) {
  try { const { data } = await base44.functions.invoke(name, payload); if (data.error) throw new Error(data.error); return data; }
  catch (error) {
    const e = new Error(error.response?.data?.error || error.data?.error || error.message || 'Could not complete the request.');
    e.status = error.response?.status || error.status || (data400(error) ? 400 : undefined);
    // The session expired or was revoked: a "Try again" button cannot fix that, so go to login and come back here afterwards.
    if (e.status === 401 && await sessionGone()) { base44.auth.redirectToLogin(window.location.href); e.message = 'Your session has ended. Redirecting to sign in…'; }
    throw e;
  }
}
async function sessionGone() {
  try { return !(await base44.auth.isAuthenticated()); } catch { return true; }
}
export const states = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
export const timezones = ['America/New_York','America/Chicago','America/Denver','America/Phoenix','America/Los_Angeles','America/Anchorage','Pacific/Honolulu'];