import type { RecommendationChannelSummary, RecommendationRouteConfig } from './recommendation-operations-types.js';

export const RECOMMENDATION_POLICY_DUE_SOON_EVENT = 'recommendation.policy.due_soon' as const;
export const RECOMMENDATION_POLICY_OVERDUE_EVENT = 'recommendation.policy.overdue' as const;
export const RECOMMENDATION_POLICY_ESCALATED_EVENT = 'recommendation.policy.escalated' as const;

export type RecommendationRoutingTrigger = 'due_soon' | 'overdue';
export type RecommendationRoutingStatusScope = 'presented' | 'accepted' | 'both';
export type RecommendationRoutingPriority = 'low' | 'medium' | 'high';
export type RecommendationRoutingSeverity = 'warning' | 'critical';
export type RecommendationPolicyDispatchStage = 'initial' | 'repeat' | 'escalation';

export interface RecommendationRoutingScope {
  pipelineIds: string[];
  teamIds: string[];
  ownerIds: string[];
  regionCodes: string[];
}

export interface RecommendationRoutingPolicy {
  id: string;
  name: string;
  trigger: RecommendationRoutingTrigger;
  statusScope: RecommendationRoutingStatusScope;
  minimumPriority: RecommendationRoutingPriority;
  thresholdMinutes: number;
  cooldownMinutes: number;
  maxNotifications: number;
  severity: RecommendationRoutingSeverity;
  routeId: string;
  escalationRouteId: string | null;
  escalationAfterMinutes: number | null;
  managerNote: string;
  scope: RecommendationRoutingScope;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string | null;
  lastMatchCount: number;
  lastQueueCount: number;
  lastError: string | null;
  dispatchSummary: {
    active: number;
    queued: number;
    delivered: number;
    failed: number;
    escalated: number;
  };
}

export interface RecommendationRoutingRouteOption extends RecommendationRouteConfig {
  channels: RecommendationChannelSummary[];
  suppressionWindowMinutes: number;
  quietHoursConfigured: boolean;
  supportedEvents: string[];
}

export interface RecommendationRoutingPolicyListResponse {
  policies: RecommendationRoutingPolicy[];
  routes: RecommendationRoutingRouteOption[];
  permissions: {
    canView: boolean;
    canManage: boolean;
    canRun: boolean;
  };
  semantics: {
    configurationAuthorizesNotifications: true;
    explicitRouteOptInRequired: true;
    quietHoursHonoured: true;
    cooldownEnforced: true;
    noCrmMutation: true;
    deterministicContentOnly: true;
  };
}

export interface RecommendationRoutingPreviewItem {
  recommendationId: string;
  dealId: string;
  label: string;
  status: string;
  priority: RecommendationRoutingPriority;
  dueAt: string | null;
  matched: boolean;
  deliveryReady: boolean;
  stage: RecommendationPolicyDispatchStage | null;
  reason: string;
  routeNames: string[];
  channelNames: string[];
}

export interface RecommendationRoutingPolicyPreview {
  evaluatedAt: string;
  matchedCount: number;
  deliveryReadyCount: number;
  escalationReadyCount: number;
  items: RecommendationRoutingPreviewItem[];
  limitations: string[];
  semantics: {
    previewSendsNothing: true;
    noCrmMutation: true;
    configurationAuthorizesNotifications: true;
  };
}
