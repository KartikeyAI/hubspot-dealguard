import { permissionMatches } from './enterprise-access.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import { requirePortalWideDeliverySloAccess } from './recommendation-delivery-slos.js';
import {
  RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
} from './recommendation-delivery-slo-types.js';
import type { Env, RequestIdentity } from './types.js';

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))];
  if (typeof value !== 'string') return [];
  try { return strings(JSON.parse(value)); } catch { return []; }
}

export async function enableRecommendationDeliverySloRouteEvents(
  env: Env,
  identity: RequestIdentity,
  routeId: string,
): Promise<{ routeId: string; eventTypes: string[]; updatedAt: string }> {
  const access = await requirePortalWideDeliverySloAccess(env, identity, 'reliability.manage');
  if (!permissionMatches(access.permissions, 'alert.manage')) {
    throw new AppError(403, 'delivery_slo_route_permission_denied', 'The alert.manage permission is required to change notification-route event subscriptions.');
  }
  const route = await env.DB.prepare(
    `SELECT id, event_types_json, pipeline_ids_json, team_ids_json,
            owner_ids_json, region_codes_json
     FROM notification_routes WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(identity.portalId, routeId).first<{
    id: string;
    event_types_json: string;
    pipeline_ids_json: string;
    team_ids_json: string;
    owner_ids_json: string;
    region_codes_json: string;
  }>();
  if (!route) throw new AppError(404, 'delivery_slo_route_not_found', 'The notification route does not exist in this portal.');
  const globalScope = [route.pipeline_ids_json, route.team_ids_json, route.owner_ids_json, route.region_codes_json]
    .every((value) => strings(value).length === 0);
  if (!globalScope) {
    throw new AppError(400, 'delivery_slo_route_scope_invalid', 'Delivery SLO alerts require a portal-wide route without pipeline, team, owner, or region filters.');
  }
  const eventTypes = [...new Set([
    ...strings(route.event_types_json),
    RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
    RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
    RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  ])];
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE notification_routes SET event_types_json = ?, updated_at = ?
     WHERE portal_id = ? AND id = ?`,
  ).bind(JSON.stringify(eventTypes), updatedAt, identity.portalId, routeId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.delivery_slo_route_opted_in', {
    routeId,
    eventTypes: [
      RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
      RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
      RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
    ],
  });
  return { routeId, eventTypes, updatedAt };
}
