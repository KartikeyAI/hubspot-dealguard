import { productPermissionAvailable } from './product-ui';

type Json = Record<string, any>;
/** Billing and identity are the page boundary. An unavailable analytics panel must
 * not prevent an authorized billing administrator from recovering a subscription.
 */
export async function loadHomeData(request: (path: string) => Promise<Json>) {
  const [billing, access] = await Promise.all([request('/billing'), request('/enterprise/access')]);
  if (!billing || typeof billing.tier !== 'string' || typeof billing.entitled !== 'boolean'
    || !access || typeof access.role !== 'string' || typeof access.entitled !== 'boolean'
    || !Array.isArray(access.permissions)) throw new Error('Your workspace access could not be verified. Refresh to try again.');
  const analyticsAllowed = productPermissionAvailable(access, 'analytics.view');
  const results = await Promise.allSettled([
    analyticsAllowed ? request('/dashboard') : Promise.resolve(null),
    productPermissionAvailable(access, 'analytics.view', true) && access.entitled
      ? request('/enterprise/overview') : Promise.resolve(null),
    analyticsAllowed && access.entitled ? request('/enterprise/analytics?days=90') : Promise.resolve(null),
  ]);
  const [dashboard, overview, analytics] = results.map(result => result.status === 'fulfilled' ? result.value : null);
  return { billing, access, dashboard, overview, analytics,
    partial: results.some(result => result.status === 'rejected'), analyticsAllowed };
}
