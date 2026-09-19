import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import type { Env } from './types.js';

export async function verifyRecordState(env: Env, portalId: string, dealId: string,
  state: 'active' | 'archived', verifiedAt: string, source: 'webhook' | 'record_read' | 'background'): Promise<boolean> {
  if (!portalId || portalId.length > 128 || !dealId || dealId.length > 128
    || !['active','archived'].includes(state) || !['webhook','record_read','background'].includes(source)
    || !evidenceInstant(verifiedAt) || Date.parse(verifiedAt) > Date.now()) {
    throw new AppError(400, 'invalid_record_evidence', 'A verified record identity and observation time are required.');
  }
  const row = await env.DB.prepare('SELECT dealguard.verify_deal_record_state(?, ?, ?, ?::timestamptz, ?) AS accepted')
    .bind(portalId,dealId,state,verifiedAt,source).first<{accepted: boolean}>();
  if (!row || typeof row.accepted !== 'boolean') throw new AppError(503, 'record_state_unavailable', 'Record availability could not be verified.');
  return row.accepted;
}

export async function assertRecordAvailable(env: Env, portalId: string, dealId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT dealguard.record_is_available(?, ?) AS available')
    .bind(portalId,dealId).first<{available: boolean}>();
  if (!row || typeof row.available !== 'boolean') throw new AppError(503, 'record_state_unavailable', 'Record availability could not be verified.');
  if (!row.available) throw new AppError(410, 'deal_archived', 'This deal is archived. Restore it in HubSpot before using DealGuard actions.');
}
