import { DEAL_HISTORY_PROPERTIES } from './config.js';
import type { HubSpotClient } from './hubspot.js';
import type { HubSpotPipeline } from './types.js';

export interface DealPropertyHistoryValue {
  value: string | null;
  timestamp: string;
  sourceType?: string;
  sourceId?: string;
  updatedByUserId?: string | null;
}

export interface MomentumStageDefinition {
  id: string;
  label: string;
  pipelineId: string;
  pipelineLabel: string;
  displayOrder: number;
  isClosed: boolean;
  isWon: boolean;
}

export interface DealHistoryContext {
  propertyHistory: Record<string, DealPropertyHistoryValue[]>;
  stageDefinitions: MomentumStageDefinition[];
  fetchedAt: string;
}

interface HubSpotHistoryObject {
  propertiesWithHistory?: Record<string, DealPropertyHistoryValue[]>;
}

interface InternalHubSpotClient {
  request<T>(path: string, init?: RequestInit, retry?: boolean): Promise<T>;
}

function normalizeHistory(values: DealPropertyHistoryValue[] | undefined): DealPropertyHistoryValue[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item) => item && Number.isFinite(Date.parse(item.timestamp)))
    .map((item) => ({ ...item, value: item.value ?? null, timestamp: new Date(item.timestamp).toISOString() }))
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

function stageDefinitions(pipelines: HubSpotPipeline[]): MomentumStageDefinition[] {
  return pipelines.flatMap((pipeline) => pipeline.stages.map((stage) => {
    const isClosed = stage.metadata?.isClosed === true || stage.metadata?.isClosed === 'true';
    const probability = Number(stage.metadata?.probability ?? 0);
    return {
      id: stage.id,
      label: stage.label,
      pipelineId: pipeline.id,
      pipelineLabel: pipeline.label,
      displayOrder: Number(stage.displayOrder ?? 0),
      isClosed,
      isWon: isClosed && probability >= 1,
    };
  }));
}

export async function loadDealHistory(client: HubSpotClient, dealId: string): Promise<DealHistoryContext> {
  const properties = DEAL_HISTORY_PROPERTIES.join(',');
  const internal = client as unknown as InternalHubSpotClient;
  const [raw, pipelineResponse] = await Promise.all([
    internal.request<HubSpotHistoryObject>(
      `/crm/objects/2026-03/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(properties)}&propertiesWithHistory=${encodeURIComponent(properties)}&archived=false`,
    ),
    internal.request<{ results: HubSpotPipeline[] }>('/crm/pipelines/2026-03/deals'),
  ]);
  const pipelines = pipelineResponse.results ?? [];
  const propertyHistory: Record<string, DealPropertyHistoryValue[]> = {};
  for (const property of DEAL_HISTORY_PROPERTIES) {
    propertyHistory[property] = normalizeHistory(raw.propertiesWithHistory?.[property]);
  }
  return {
    propertyHistory,
    stageDefinitions: stageDefinitions(pipelines),
    fetchedAt: new Date().toISOString(),
  };
}
