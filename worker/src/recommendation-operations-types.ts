import type { IssueSeverity } from './types.js';

export const RECOMMENDATION_FOLLOWUP_EVENT = 'recommendation.followup.requested' as const;

export type RecommendationFollowupKind = 'owner_reminder' | 'manager_review';
export type RecommendationFollowupSeverity = Extract<IssueSeverity, 'warning' | 'critical'>;
export type RecommendationFollowupBatchStatus =
  | 'previewed'
  | 'confirming'
  | 'queued'
  | 'delivering'
  | 'completed'
  | 'partially_failed'
  | 'failed'
  | 'expired';
export type RecommendationFollowupItemStatus =
  | 'previewed'
  | 'unroutable'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'partially_failed'
  | 'failed'
  | 'skipped';

export interface RecommendationFollowupScope {
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
}

export interface RecommendationRouteConfig {
  id: string;
  name: string;
  eventTypes: string[];
  minimumSeverity: IssueSeverity;
  pipelineIds: string[];
  teamIds: string[];
  ownerIds: string[];
  regionCodes: string[];
  channelIds: string[];
  quietHoursCalendarId: string | null;
  enabled: boolean;
}

export interface RecommendationChannelSummary {
  id: string;
  name: string;
  type: 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';
}

export interface RecommendationFollowupRoutingMatch {
  routeIds: string[];
  channelIds: string[];
  routes: Array<{
    id: string;
    name: string;
    channelIds: string[];
    channelNames: string[];
  }>;
  fingerprint: string;
  ready: boolean;
}

export interface RecommendationFollowupPreviewItem {
  recommendationId: string;
  dealId: string;
  recommendationCode: string;
  label: string;
  action: string;
  recommendationStatus: string;
  priority: 'high' | 'medium' | 'low';
  dueAt: string | null;
  overdue: boolean;
  scope: RecommendationFollowupScope;
  status: RecommendationFollowupItemStatus;
  eligible: boolean;
  deliveryReady: boolean;
  ineligibilityReason: string | null;
  routing: RecommendationFollowupRoutingMatch;
}

export interface RecommendationFollowupBatchView {
  id: string;
  kind: RecommendationFollowupKind;
  severity: RecommendationFollowupSeverity;
  managerNote: string;
  status: RecommendationFollowupBatchStatus;
  requestedCount: number;
  eligibleCount: number;
  deliveryReadyCount: number;
  confirmedCount: number;
  deliveredCount: number;
  failedCount: number;
  deliveryReady: boolean;
  confirmationRequired: boolean;
  previewExpiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: RecommendationFollowupPreviewItem[];
  semantics: {
    explicitRouteOptInRequired: true;
    humanConfirmationRequired: true;
    noCrmMutation: true;
    noAutonomousOutreach: true;
    notificationContentIsDeterministic: true;
  };
}

export interface RecommendationFollowupDeliveryResult {
  channelId: string;
  channelName: string;
  channelType: RecommendationChannelSummary['type'];
  status: 'delivered' | 'failed';
  error: string | null;
}
