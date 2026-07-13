import { requireGovernancePermission } from './governance.js';
import { HubSpotClient } from './hubspot.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

export interface PolicyDimensionMappings {
  teamProperty: string | null;
  regionProperty: string | null;
  dealTypeProperty: string | null;
}

interface MappingRow {
  team_property: string | null;
  region_property: string | null;
  deal_type_property: string | null;
}

const PROPERTY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/;

function property(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !PROPERTY_PATTERN.test(value.trim())) {
    throw new AppError(400, 'dimension_property_invalid', 'Dimension mappings must use valid HubSpot internal deal-property names.');
  }
  return value.trim();
}

function map(row: MappingRow | null): PolicyDimensionMappings {
  return {
    teamProperty: row?.team_property ?? null,
    regionProperty: row?.region_property ?? null,
    dealTypeProperty: row?.deal_type_property ?? null,
  };
}

export async function getPolicyDimensionMappings(env: Env, portalId: string): Promise<PolicyDimensionMappings> {
  const row = await env.DB.prepare(
    `SELECT team_property, region_property, deal_type_property
     FROM policy_dimension_mappings WHERE portal_id = ?`,
  ).bind(portalId).first<MappingRow>();
  return map(row);
}

export async function policyDimensionPropertyNames(env: Env, portalId: string): Promise<string[]> {
  const mappings = await getPolicyDimensionMappings(env, portalId);
  return [...new Set([
    mappings.teamProperty,
    mappings.regionProperty,
    mappings.dealTypeProperty,
  ].filter((value): value is string => Boolean(value)))];
}

export async function updatePolicyDimensionMappings(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<PolicyDimensionMappings> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const mappings: PolicyDimensionMappings = {
    teamProperty: property(input.teamProperty),
    regionProperty: property(input.regionProperty),
    dealTypeProperty: property(input.dealTypeProperty),
  };
  const requested = [...new Set([
    mappings.teamProperty,
    mappings.regionProperty,
    mappings.dealTypeProperty,
  ].filter((item): item is string => Boolean(item)))];
  if (requested.length > 0) {
    const client = await HubSpotClient.forPortal(env, identity.portalId);
    const available = new Map((await client.getAllDealProperties()).map((item) => [item.name, item]));
    const missing = requested.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new AppError(409, 'dimension_properties_missing', 'One or more configured dimension properties do not exist in this HubSpot portal.', { missing });
    }
    const unsupported = requested.filter((name) => {
      const definition = available.get(name);
      return Boolean(definition?.calculated || definition?.hidden);
    });
    if (unsupported.length > 0) {
      throw new AppError(409, 'dimension_properties_unsupported', 'Hidden or calculated properties cannot be used as DealGuard policy dimensions.', { unsupported });
    }
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_dimension_mappings
     (portal_id, team_property, region_property, deal_type_property,
      updated_by_user_id, updated_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET
       team_property = excluded.team_property,
       region_property = excluded.region_property,
       deal_type_property = excluded.deal_type_property,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_email = excluded.updated_by_email,
       updated_at = excluded.updated_at`,
  ).bind(
    identity.portalId,
    mappings.teamProperty,
    mappings.regionProperty,
    mappings.dealTypeProperty,
    identity.userId,
    identity.userEmail,
    now,
    now,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.dimension_mappings_updated', mappings);
  return mappings;
}

export function dimensionValues(
  properties: Record<string, string | null | undefined>,
  mappings: PolicyDimensionMappings,
): { teamId: string; regionCode: string; dealType: string } {
  return {
    teamId: mappings.teamProperty ? properties[mappings.teamProperty] ?? '' : '',
    regionCode: mappings.regionProperty ? properties[mappings.regionProperty] ?? '' : '',
    dealType: mappings.dealTypeProperty ? properties[mappings.dealTypeProperty] ?? '' : '',
  };
}
