import { CORE_DEAL_PROPERTIES } from './config.js';
import { AppError } from './errors.js';
import { Repository, type TenantCredentials } from './repository.js';
import type {
  Env,
  HubSpotObject,
  HubSpotPipeline,
  HubSpotProperty,
  HubSpotSearchResponse,
  HubSpotTokenInfo,
  HubSpotTokenResponse,
  NormalizedDeal,
  StageInfo,
} from './types.js';

const API_BASE = 'https://api.hubapi.com';

interface AssociationBatchResponse {
  results?: Array<{ from: { id: string }; to: Array<{ toObjectId: number }> }>;
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

  async getPipelines(): Promise<HubSpotPipeline[]> {
    const response = await this.request<{ results: HubSpotPipeline[] }>('/crm/v3/pipelines/deals');
    return response.results;
  }

  async getDealProperties(): Promise<HubSpotProperty[]> {
    const response = await this.request<{ results: HubSpotProperty[] }>('/crm/v3/properties/deals?archived=false');
    return response.results
      .filter((property) => !property.hidden && !property.calculated && !property.modificationMetadata?.readOnlyValue)
      .sort((left, right) => left.label.localeCompare(right.label));
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

  async getDeal(dealId: string, stageMap?: Map<string, StageInfo>): Promise<NormalizedDeal> {
    const map = stageMap ?? await this.buildStageMap();
    const stageProperties = [...map.values()].map((stage) => stage.enteredAtProperty);
    const customProperties = this.settings.rules.customRequiredProperties.map((rule) => rule.property);
    const properties = [...new Set([...CORE_DEAL_PROPERTIES, ...stageProperties, ...customProperties])].join(',');
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

  async listDeals(maxDeals: number): Promise<NormalizedDeal[]> {
    const stageMap = await this.buildStageMap();
    const stageProperties = [...stageMap.values()].map((stage) => stage.enteredAtProperty);
    const customProperties = this.settings.rules.customRequiredProperties.map((rule) => rule.property);
    const properties = [...new Set([...CORE_DEAL_PROPERTIES, ...stageProperties, ...customProperties])];
    const closedLostStageIds = [...stageMap.values()]
      .filter((stage) => stage.isClosed && !stage.isWon)
      .map((stage) => stage.id);
    const deals: HubSpotObject[] = [];
    let after: string | undefined;
    while (deals.length < maxDeals) {
      const limit = Math.min(100, maxDeals - deals.length);
      const filters: Array<Record<string, unknown>> = [{ propertyName: 'dealstage', operator: 'HAS_PROPERTY' }];
      if (closedLostStageIds.length > 0) {
        filters.push({ propertyName: 'dealstage', operator: 'NOT_IN', values: closedLostStageIds });
      }
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
