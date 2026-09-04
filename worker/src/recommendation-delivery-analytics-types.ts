export type RecommendationDeliveryEventType =
  | 'policy_matched'
  | 'quiet_hours_deferred'
  | 'cooldown_suppressed'
  | 'notification_limit_suppressed'
  | 'route_unavailable'
  | 'dispatch_resolved';

export type DeliveryAuthorizationMode = 'human_confirmation' | 'configured_policy';
export type DeliveryHealth = 'healthy' | 'watch' | 'degraded' | 'unavailable';

export interface DeliveryChannelResult {
  channelId: string;
  channelName: string;
  channelType: 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';
  status: 'delivered' | 'failed';
  error: string | null;
}

export interface DeliveryAnalyticsAttempt {
  batchId: string;
  itemId: string;
  recommendationId: string;
  dealId: string;
  authorizationMode: DeliveryAuthorizationMode;
  policyId: string | null;
  policyName: string | null;
  trigger: 'due_soon' | 'overdue' | null;
  escalationAfterMinutes: number | null;
  dispatchId: string | null;
  batchStatus: string;
  itemStatus: string;
  kind: 'owner_reminder' | 'manager_review';
  severity: 'warning' | 'critical';
  createdAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  recommendationDueAt: string | null;
  firstMatchedAt: string | null;
  firstQueuedAt: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  routeIds: string[];
  channelIds: string[];
  channelResults: DeliveryChannelResult[];
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
}

export interface DeliveryAnalyticsEvent {
  id: string;
  eventType: RecommendationDeliveryEventType;
  policyId: string | null;
  dispatchId: string | null;
  recommendationId: string | null;
  routeId: string | null;
  stage: 'initial' | 'repeat' | 'escalation' | null;
  reasonCode: string | null;
  eventAt: string;
  recommendationDueAt: string | null;
  slaDueAt: string | null;
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
}

export interface DeliveryAnalyticsDispatch {
  id: string;
  policyId: string;
  policyName: string;
  trigger: 'due_soon' | 'overdue';
  escalationAfterMinutes: number | null;
  recommendationId: string;
  state: 'active' | 'resolved';
  firstMatchedAt: string;
  firstQueuedAt: string | null;
  lastQueuedAt: string | null;
  nextEligibleAt: string | null;
  notificationCount: number;
  escalationCount: number;
  escalatedAt: string | null;
  resolvedAt: string | null;
  lastDeliveryStatus: 'queued' | 'completed' | 'partially_failed' | 'failed' | null;
  pipelineId: string | null;
  teamId: string | null;
  ownerId: string | null;
  regionCode: string | null;
}

export interface DeliveryAnalyticsRouteDefinition {
  id: string;
  name: string;
}

export interface DeliveryAnalyticsChannelDefinition {
  id: string;
  name: string;
  type: DeliveryChannelResult['channelType'];
}

export interface RecommendationDeliveryAnalyticsResponse {
  generatedAt: string;
  methodology: 'deterministic_recommendation_delivery_analytics_v1';
  window: { days: number; start: string; end: string };
  summary: {
    batches: number;
    manualBatches: number;
    policyBatches: number;
    attemptedItems: number;
    deliveredItems: number;
    partiallyFailedItems: number;
    failedItems: number;
    deliverySuccessPercent: number;
    medianCompletionMinutes: number | null;
    p95CompletionMinutes: number | null;
    primaryQueued: number;
    repeatQueued: number;
    escalationQueued: number;
    escalationSlaEligible: number;
    escalationSlaCompliant: number;
    escalationSlaBreached: number;
    escalationSlaCompliancePercent: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
    notificationLimitSuppressions: number;
    routeUnavailable: number;
    resolvedDispatches: number;
  };
  policies: Array<{
    policyId: string;
    policyName: string;
    trigger: 'due_soon' | 'overdue';
    matched: number;
    primaryQueued: number;
    repeatQueued: number;
    escalationQueued: number;
    attemptedItems: number;
    deliveredItems: number;
    failedItems: number;
    deliverySuccessPercent: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
    notificationLimitSuppressions: number;
    routeUnavailable: number;
    escalationSlaEligible: number;
    escalationSlaCompliant: number;
    escalationSlaBreached: number;
    escalationSlaCompliancePercent: number;
    medianFirstQueueMinutes: number | null;
    health: DeliveryHealth;
  }>;
  routes: Array<{
    routeId: string;
    routeName: string;
    attemptedChannels: number;
    deliveredChannels: number;
    failedChannels: number;
    deliverySuccessPercent: number;
    quietHourDeferrals: number;
    routeUnavailable: number;
    lastDeliveryAt: string | null;
    health: DeliveryHealth;
  }>;
  channels: Array<{
    channelId: string;
    channelName: string;
    channelType: DeliveryChannelResult['channelType'];
    attempted: number;
    delivered: number;
    failed: number;
    deliverySuccessPercent: number;
    lastDeliveryAt: string | null;
    health: DeliveryHealth;
  }>;
  timeline: Array<{
    date: string;
    attemptedItems: number;
    deliveredItems: number;
    failedItems: number;
    escalationsQueued: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
  }>;
  recentFailures: Array<{
    batchId: string;
    recommendationId: string;
    dealId: string;
    channelId: string | null;
    channelName: string;
    channelType: DeliveryChannelResult['channelType'] | null;
    policyId: string | null;
    policyName: string | null;
    occurredAt: string;
    error: string;
  }>;
  coverage: {
    loadedAttempts: number;
    loadedEvents: number;
    loadedDispatches: number;
    completedAttemptPercent: number;
    channelEvidencePercent: number;
    truncated: boolean;
  };
  limitations: string[];
  semantics: {
    operationalDeliveryOnly: true;
    notDealOutcome: true;
    noCausalAttribution: true;
    noCrmMutation: true;
    escalationSlaUsesConfiguredThreshold: true;
    schedulerGraceMinutes: number;
    suppressionCountsAreDeduplicatedOperationalEvents: true;
  };
}
