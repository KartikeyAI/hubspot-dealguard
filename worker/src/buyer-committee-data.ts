import type { HubSpotClient } from './hubspot.js';

export const BUYER_COMMITTEE_CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'jobtitle',
  'hs_buying_role',
  'lastmodifieddate',
] as const;

export const BUYER_COMMITTEE_COMPANY_PROPERTIES = [
  'name',
  'domain',
  'industry',
  'hs_lastmodifieddate',
] as const;

const MAX_CONTACTS = 100;
const MAX_COMPANIES = 20;

export interface AssociationTypeEvidence {
  category?: string;
  typeId: number;
  label: string | null;
}

export interface BuyerCommitteeContactRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
  associationTypes: AssociationTypeEvidence[];
  updatedAt?: string;
}

export interface BuyerCommitteeCompanyRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
  associationTypes: AssociationTypeEvidence[];
  updatedAt?: string;
}

export interface BuyerCommitteeData {
  contacts: BuyerCommitteeContactRecord[];
  companies: BuyerCommitteeCompanyRecord[];
  contactsTruncated: boolean;
  companiesTruncated: boolean;
  fetchedAt: string;
}

interface AssociationTarget {
  toObjectId: string | number;
  associationTypes?: AssociationTypeEvidence[];
}

interface AssociationBatchResponse {
  results?: Array<{
    from: { id: string };
    to: AssociationTarget[];
    paging?: { next?: { after?: string } };
  }>;
}

interface ObjectBatchResponse {
  results?: Array<{
    id: string;
    properties: Record<string, string | null | undefined>;
    updatedAt?: string;
  }>;
}

interface InternalHubSpotClient {
  request<T>(path: string, init?: RequestInit, retry?: boolean): Promise<T>;
}

async function associationTargets(
  internal: InternalHubSpotClient,
  dealId: string,
  toObjectType: 'contacts' | 'companies',
  maximum: number,
): Promise<{ targets: Map<string, AssociationTypeEvidence[]>; truncated: boolean }> {
  const targets = new Map<string, AssociationTypeEvidence[]>();
  let after: string | undefined;
  let truncated = false;

  do {
    const input: { id: string; after?: string } = { id: dealId };
    if (after) input.after = after;
    const response = await internal.request<AssociationBatchResponse>(
      `/crm/associations/2026-03/deals/${toObjectType}/batch/read`,
      { method: 'POST', body: JSON.stringify({ inputs: [input] }) },
    );
    const result = response.results?.find((item) => item.from.id === dealId) ?? response.results?.[0];
    const pageTargets = result?.to ?? [];
    for (let index = 0; index < pageTargets.length; index += 1) {
      if (targets.size >= maximum) {
        truncated = true;
        break;
      }
      const target = pageTargets[index]!;
      const id = String(target.toObjectId);
      const existing = targets.get(id) ?? [];
      const merged = [...existing];
      for (const type of target.associationTypes ?? []) {
        if (!merged.some((item) => item.typeId === type.typeId && item.category === type.category)) merged.push(type);
      }
      targets.set(id, merged);
      if (targets.size >= maximum && index < pageTargets.length - 1) truncated = true;
    }
    after = result?.paging?.next?.after;
    if (targets.size >= maximum && after) truncated = true;
  } while (after && targets.size < maximum);

  return { targets, truncated };
}

async function batchReadRecords(
  internal: InternalHubSpotClient,
  objectType: 'contacts' | 'companies',
  ids: string[],
  properties: readonly string[],
): Promise<Array<{ id: string; properties: Record<string, string | null | undefined>; updatedAt?: string }>> {
  const output: Array<{ id: string; properties: Record<string, string | null | undefined>; updatedAt?: string }> = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    if (batch.length === 0) continue;
    const response = await internal.request<ObjectBatchResponse>(
      `/crm/objects/2026-03/${objectType}/batch/read`,
      {
        method: 'POST',
        body: JSON.stringify({
          properties: [...properties],
          inputs: batch.map((id) => ({ id })),
        }),
      },
    );
    output.push(...(response.results ?? []));
  }
  return output;
}

export async function loadBuyerCommitteeData(client: HubSpotClient, dealId: string): Promise<BuyerCommitteeData> {
  const internal = client as unknown as InternalHubSpotClient;
  const [contactAssociations, companyAssociations] = await Promise.all([
    associationTargets(internal, dealId, 'contacts', MAX_CONTACTS),
    associationTargets(internal, dealId, 'companies', MAX_COMPANIES),
  ]);
  const [contacts, companies] = await Promise.all([
    batchReadRecords(internal, 'contacts', [...contactAssociations.targets.keys()], BUYER_COMMITTEE_CONTACT_PROPERTIES),
    batchReadRecords(internal, 'companies', [...companyAssociations.targets.keys()], BUYER_COMMITTEE_COMPANY_PROPERTIES),
  ]);

  return {
    contacts: contacts.map((record) => ({
      ...record,
      associationTypes: contactAssociations.targets.get(record.id) ?? [],
    })),
    companies: companies.map((record) => ({
      ...record,
      associationTypes: companyAssociations.targets.get(record.id) ?? [],
    })),
    contactsTruncated: contactAssociations.truncated,
    companiesTruncated: companyAssociations.truncated,
    fetchedAt: new Date().toISOString(),
  };
}
