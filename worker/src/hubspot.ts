import { CORE_DEAL_PROPERTIES, DEALGUARD_NATIVE_PROPERTY_NAMES } from './config.js';
import { AppError } from './errors.js';
import { Repository, type TenantCredentials } from './repository.js';
import type {
  Env,
  HubSpotDealUpdate,
  HubSpotObject,
  HubSpotPipeline,
  HubSpotProperty,
  HubSpotPropertyDefinition,
  HubSpotSearchResponse,
  HubSpotTokenInfo,
  HubSpotTokenResponse,
  NormalizedDeal,
  StageInfo,
} from './types.js';

const API_BASE = 'https://api.hubapi.com';
const ALLOWED_NATIVE_PROPERTY_NAMES = new Set<string>(DEALGUARD_NATIVE_PROPERTY_NAMES);
const PROPERTY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/;

interface AssociationBatchResponse {
  results?: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
}

interface AssociationLabelResponse {
  results?: Array<{ category: string; typeId: number; label: string | null }>;
}

function validatedReadProperties(properties: string[]): string[] {
  const invalid = properties.filter((property) => !PROPERTY_PATTERN.test(property));
  if (invalid.length > 0) {
    throw new AppError(500, 'hubspot_property_read_blocked', 'DealGuard blocked invalid HubSpot property names.', { invalid });
  }
  return [...new Set(properties)].slice(0, 500);
}

export class HubSpotClient {
  private credentials: TenantCredentials;
  private readonly repository: Repository;

  private constructor(private readonly env: Env, credentials: TenantCredentials) {
    this.credentials = credentials;
    this.repository = new Repository(env);
  }

  static async forPortal(env: Env, portalId: string): Promise<HubSpotClient> {
    return new HubSpotClient(env, await new Repository(env).getCredentials(portalId));
  }

  static async exchangeCode(env: Env, code: string): Promise<HubSpotTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.HUBSPOT_CLIENT_ID,
      client_secret: env.HUBSPOT_CLIENT_SECRET,
      redirect_uri: `${env.APP_BASE_URL}/oauth/callback`,
      code,
    });
    const response = await fetch(`${API_BASE}/oauth/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    if (!response.ok) throw new AppError(502, 'oauth_exchange_failed', 'HubSpot rejected the OAuth authorization code.');
    return (await response.json()) as HubSpotTokenResponse;
  }

  static async tokenInfo(accessToken: string): Promise<HubSpotTokenInfo> {
    const response = await fetch(`${API_BASE}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
    if (!response.ok) throw new AppError(502, 'token_info_failed', 'HubSpot token metadata could not be retrieved.');
    return (await response.json()) as HubSpotTokenInfo;
  }

  get portalId(): string {
    return this.credentials.tenant.portal_id;
  }

  get settings() {
    return this.credentials.settings;
  }

  get plan() {
    return this.credentials.tenant.plan;
  }

  private async refreshIfNeeded(): Promise<void> {
    if (Date.parse(this.credentials.tenant.token_expires_at) > Date.now() + 60_000) return;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.env.HUBSPOT_CLIENT_ID,
      client_secret: this.env.HUBSPOT_CLIENT_SECRET,
      refresh_token: this.credentials.refreshToken,
    });
    const response = await fetch(`${API_BASE}/oauth/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    if (!response.ok) {
      await this.repository.markDisconnected(this.portalId, `refresh_failed_${response.status}`);
      throw new AppError(401, 'hubspot_reauthorization_required', 'HubSpot authorization has expired. Reconnect DealGuard.');
    }
    const tokens = (await response.json()) as HubSpotTokenResponse;
    await this.repository.updateTokens(this.portalId, tokens);
    this.credentials = await this.repository.getCredentials(this.portalId);
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    await this.refreshIfNeeded();
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.credentials.accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (response.status === 401 && retry) {
      this.credentials.tenant.token_expires_at = new Date(0).toISOString();
      await this.refreshIfNeeded();
      return this.request<T>(path, init, false);
    }
    if (response.status === 429) throw new AppError(429, 'hubspot_rate_limited', 'HubSpot rate limited the request. Retry later.');
    if (!response.ok) {
      const body = await response.text();
      throw new AppError(502, 'hubspot_api_error', `HubSpot API request failed with status ${response.status}.`, body.slice(0, 500));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private assertAllowedNativeProperties(properties: Record<string, string>): void {
    const blocked = Object.keys(properties).filter((name) => !ALLOWED_NATIVE_PROPERTY_NAMES.has(name));
    if (blocked.length > 0) {
      throw new AppError(
        500,
        'native_property_write_blocked',
        'DealGuard blocked an attempted write outside its fixed native property allowlist.',
        { blocked },
      );
    }
  }

  async getPipelines(): Promise<HubSpotPipeline[]> {
    const response = await this.request<{ results: HubSpotPipeline[] }>('/crm/v3/pipelines/deals');
    return response.results;
  }

  async getAllDealProperties(): Promise<HubSpotProperty[]> {
    const response = await this.request<{ results: HubSpotProperty[] }>('/crm/v3/properties/deals?archived=false');
    return response.results;
  }

  async getDealProperties(): Promise<HubSpotProperty[]> {
    return (await this.getAllDealProperties())
      .filter((property) => !property.hidden && !property.calculated && !property.modificationMetadata?.readOnlyValue)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async ensureDealProperties(definitions: HubSpotPropertyDefinition[]): Promise<void> {
    const existing = new Map((await this.getAllDealProperties()).map((property) => [property.name, property]));
    for (const definition of definitions) {
      if (!ALLOWED_NATIVE_PROPERTY_NAMES.has(definition.name)) {
        throw new AppError(500, 'native_property_definition_blocked', 'DealGuard refused to provision a property outside its fixed allowlist.');
      }
      const current = existing.get(definition.name);
      if (current) {
        const expectedOptions = definition.options?.map((option) => option.value) ?? [];
        const currentOptions = new Set((current.options ?? []).map((option) => option.value));
        const optionsCompatible = expectedOptions.every((value) => currentOptions.has(value));
        if (current.type !== definition.type || current.fieldType !== definition.fieldType || !optionsCompatible) {
          throw new AppError(409, 'native_property_conflict', `HubSpot property ${definition.name} already exists with an incompatible definition.`);
        }
        continue;
      }
      await this.request<HubSpotProperty>('/crm/v3/properties/deals', {
        method: 'POST',
        body: JSON.stringify({ ...definition, hidden: false, formField: false, hasUniqueValue: false }),
      });
    }
  }

  async updateDealProperties(dealId: string, properties: Record<string, string>): Promise<void> {
    this.assertAllowedNativeProperties(properties);
    await this.request<HubSpotObject>(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });
  }

  async batchUpdateDeals(updates: HubSpotDealUpdate[]): Promise<void> {
    for (const update of updates) this.assertAllowedNativeProperties(update.properties);
    for (let offset = 0; offset < updates.length; offset += 100) {
      const batch = updates.slice(offset, offset + 100);
      if (batch.length === 0) continue;
      await this.request<{ results: HubSpotObject[] }>('/crm/v3/objects/deals/batch/update', {
        method: 'POST',
        body: JSON.stringify({ inputs: batch }),
      });
    }
  }

  async createRemediationTask(input: {
    dealId: string;
    subject: string;
    body: string;
    dueAt: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH';
    ownerId?: string | null;
  }): Promise<string> {
    const labels = await this.request<AssociationLabelResponse>('/crm/v4/associations/tasks/deals/labels');
    const association = (labels.results ?? []).find((item) => item.category === 'HUBSPOT_DEFINED' && item.label === null)
      ?? (labels.results ?? []).find((item) => item.category === 'HUBSPOT_DEFINED');
    if (!association) {
      throw new AppError(409, 'task_deal_association_missing', 'HubSpot did not expose a task-to-deal association definition. DealGuard will not create an unassociated remediation task.');
    }
    const properties: Record<string, string> = {
      hs_timestamp: input.dueAt,
      hs_task_subject: input.subject.slice(0, 255),
      hs_task_body: input.body.slice(0, 65000),
      hs_task_status: 'NOT_STARTED',
      hs_task_priority: input.priority,
      hs_task_type: 'TODO',
    };
    if (input.ownerId) properties.hubspot_owner_id = input.ownerId;
    const task = await this.request<HubSpotObject>('/crm/v3/objects/tasks', {
      method: 'POST',
      body: JSON.stringify({
        properties,
        associations: [{
          to: { id: input.dealId },
          types: [{ associationCategory: association.category, associationTypeId: association.typeId }],
        }],
      }),
    });
    return task.id;
  }

  async buildStageMap(): Promise<Map<string, StageInfo>> {
    const pipelines = await this.getPipelines();
    const map = new Map<string, StageInfo>();
    for (const pipeline of pipelines) {
      for (const stage of pipeline.stages) {
        const isClosed = stage.metadata?.isClosed === true || stage.metadata?.isClosed === 'true';
        const probability = Number(stage.metadata?.probability ?? 0);
        map.set(stage.id, {
          id: stage.id,
          label: stage.label,
          pipelineId: pipeline.id,
          pipelineLabel: pipeline.label,
          isClosed,
          isWon: isClosed && probability >= 1,
          enteredAtProperty: `hs_date_entered_${stage.id}`,
        });
      }
    }
    return map;
  }

  async getDeal(
    dealId: string,
    stageMap?: Map<string, StageInfo>,
    extraProperties: string[] = [],
  ): Promise<NormalizedDeal> {
    const map = stageMap ?? await this.buildStageMap();
    const stageProperties = [...map.values()].map((stage) => stage.enteredAtProperty);
    const customProperties = this.settings.rules.customRequiredProperties.map((rule) => rule.property);
    const properties = validatedReadProperties([
      ...CORE_DEAL_PROPERTIES,
      ...stageProperties,
      ...customProperties,
      ...extraProperties,
    ]).join(',');
    const result = await this.request<HubSpotObject>(
      `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(properties)}&associations=contacts,companies&archived=false`,
    );
    const stage = map.get(result.properties.dealstage ?? '');
    return {
      id: result.id,
      properties: result.properties,
      contactCount: result.associations?.contacts?.results.length ?? 0,
      companyCount: result.associations?.companies?.results.length ?? 0,
      ...(stage ? { stage } : {}),
    };
  }

  async listDeals(maxDeals: number, extraProperties: string[] = []): Promise<NormalizedDeal[]> {
    const stageMap = await this.buildStageMap();
    const stageProperties = [...stageMap.values()].map((stage) => stage.enteredAtProperty);
    const customProperties = this.settings.rules.customRequiredProperties.map((rule) => rule.property);
    const properties = validatedReadProperties([
      ...CORE_DEAL_PROPERTIES,
      ...stageProperties,
      ...customProperties,
      ...extraProperties,
    ]);
    const closedLostStageIds = [...stageMap.values()].filter((stage) => stage.isClosed && !stage.isWon).map((stage) => stage.id);
    const deals: HubSpotObject[] = [];
    let after: string | undefined;
    while (deals.length < maxDeals) {
      const limit = Math.min(100, maxDeals - deals.length);
      const filters: Array<Record<string, unknown>> = [{ propertyName: 'dealstage', operator: 'HAS_PROPERTY' }];
      if (closedLostStageIds.length > 0) filters.push({ propertyName: 'dealstage', operator: 'NOT_IN', values: closedLostStageIds });
      const body: Record<string, unknown> = {
        limit,
        properties,
        sorts: ['-hs_lastmodifieddate'],
        filterGroups: [{ filters }],
      };
      if (after) body.after = after;
      const page = await this.request<HubSpotSearchResponse>('/crm/v3/objects/deals/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      deals.push(...page.results);
      after = page.paging?.next?.after;
      if (!after || page.results.length === 0) break;
    }

    const ids = deals.map((deal) => deal.id);
    const [contacts, companies] = await Promise.all([
      this.batchAssociationCounts('deals', 'contacts', ids),
      this.batchAssociationCounts('deals', 'companies', ids),
    ]);

    return deals.map((deal) => {
      const stage = stageMap.get(deal.properties.dealstage ?? '');
      return {
        id: deal.id,
        properties: deal.properties,
        contactCount: contacts.get(deal.id) ?? 0,
        companyCount: companies.get(deal.id) ?? 0,
        ...(stage ? { stage } : {}),
      };
    });
  }

  private async batchAssociationCounts(fromType: string, toType: string, ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      if (batch.length === 0) continue;
      const result = await this.request<AssociationBatchResponse>(
        `/crm/v4/associations/${fromType}/${toType}/batch/read`,
        { method: 'POST', body: JSON.stringify({ inputs: batch.map((id) => ({ id })) }) },
      );
      for (const item of result.results ?? []) counts.set(item.from.id, item.to.length);
    }
    return counts;
  }
}
