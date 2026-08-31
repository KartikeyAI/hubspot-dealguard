import type { RecommendationChannelSummary, RecommendationFollowupRoutingMatch } from './recommendation-operations-types.js';

export const RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT = 'recommendation.delivery.slo.breached' as const;
export const RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT = 'recommendation.delivery.slo.reminder' as const;
export const RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT = 'recommendation.delivery.slo.recovered' as const;

export type RecommendationDeliverySloEventType =
  | typeof RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT
  | typeof RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT
  | typeof RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT;

export type RecommendationDeliverySloMetric =
  | 'delivery_success_percent'
  | 'failure_count'
  | 'route_unavailable_count'
  | 'escalation_sla_breach_count'
  | 'p95_completion_minutes';

export type RecommendationDeliverySloTargetType = 'portal' | 'route' | 'channel' | 'routing_policy';
export type RecommendationDeliverySloComparison = 'minimum' | 'maximum';
export type RecommendationDeliverySloStatus = 'insufficient_data' | 'meeting' | 'breaching' | 'breached' | 'recovering';
export type RecommendationDeliverySloIncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type RecommendationDeliverySloNotificationStatus =
  | 'queued'
  | 'delivering'
  | 'deferred'
  | 'delivered'
  | 'partially_failed'
  | 'failed';

export interface RecommendationDeliverySloPolicy {
  id: string;
  name: string;
  metric: RecommendationDeliverySloMetric;
  targetType: RecommendationDeliverySloTargetType;
  targetId: string | null;
  targetLabel: string;
  comparison: RecommendationDeliverySloComparison;
  thresholdValue: number;
  windowMinutes: number;
  minimumSamples: number;
  breachEvaluations: number;
  recoveryEvaluations: number;
  severity: 'warning' | 'critical';
  notificationRouteId: string;
  notificationRouteName: string;
  alertCooldownMinutes: number;
  maxAlertsPerIncident: number;
  notifyRecovery: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string | null;
  lastValue: number | null;
  lastSampleCount: number;
  lastStatus: RecommendationDeliverySloStatus | null;
  lastError: string | null;
}

export interface RecommendationDeliverySloState {
  status: RecommendationDeliverySloStatus;
  consecutiveBreaches: number;
  consecutiveRecoveries: number;
  firstBreachedAt: string | null;
  lastBreachedAt: string | null;
  lastRecoveredAt: string | null;
  lastAlertAt: string | null;
  nextAlertAt: string | null;
  currentValue: number | null;
  sampleCount: number;
  evidenceStartAt: string | null;
  evidenceEndAt: string | null;
  evidenceTruncated: boolean;
  lastReason: string | null;
  evaluatedAt: string;
}

export interface RecommendationDeliverySloIncident {
  id: string;
  sloPolicyId: string;
  policyName: string;
  status: RecommendationDeliverySloIncidentStatus;
  severity: 'warning' | 'critical';
  metric: RecommendationDeliverySloMetric;
  targetType: RecommendationDeliverySloTargetType;
  targetId: string | null;
  targetLabel: string;
  comparison: RecommendationDeliverySloComparison;
  thresholdValue: number;
  firstValue: number | null;
  worstValue: number | null;
  lastValue: number | null;
  lastSampleCount: number;
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  alertCount: number;
  lastNotificationId: string | null;
  lastNotificationStatus: RecommendationDeliverySloNotificationStatus | null;
  lastAlertAt: string | null;
}

export interface RecommendationDeliverySloNotification {
  id: string;
  incidentId: string;
  sloPolicyId: string;
  policyName: string;
  routeId: string;
  routeName: string;
  eventType: RecommendationDeliverySloEventType;
  severity: 'info' | 'warning' | 'critical';
  status: RecommendationDeliverySloNotificationStatus;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  deliverySummary: Array<{
    channelId: string;
    channelName: string;
    channelType: RecommendationChannelSummary['type'];
    status: 'delivered' | 'failed';
    error: string | null;
  }>;
}

export interface RecommendationDeliverySloObservation {
  value: number | null;
  sampleCount: number;
  breached: boolean;
  sufficient: boolean;
  truncated: boolean;
  evidenceStartAt: string;
  evidenceEndAt: string;
  reason: string;
}

export interface RecommendationDeliverySloLifecycleDecision {
  nextState: RecommendationDeliverySloState;
  action: 'none' | 'open_incident' | 'update_incident' | 'send_reminder' | 'resolve_incident';
}

export interface RecommendationDeliverySloRouteOption {
  id: string;
  name: string;
  eventTypes: string[];
  enabled: boolean;
  globalScope: boolean;
  quietHoursConfigured: boolean;
  suppressionWindowMinutes: number;
  channels: RecommendationChannelSummary[];
}

export interface RecommendationDeliverySloTargetOption {
  id: string;
  label: string;
  type: Exclude<RecommendationDeliverySloTargetType, 'portal'>;
}

export interface RecommendationDeliverySloListResponse {
  generatedAt: string;
  policies: Array<RecommendationDeliverySloPolicy & { state: RecommendationDeliverySloState | null }>;
  incidents: RecommendationDeliverySloIncident[];
  notifications: RecommendationDeliverySloNotification[];
  routes: RecommendationDeliverySloRouteOption[];
  targets: RecommendationDeliverySloTargetOption[];
  permissions: {
    canView: boolean;
    canManage: boolean;
    portalWideAccess: boolean;
  };
  limits: {
    maxPolicies: number;
    evaluationCadenceMinutes: number;
    evidenceRetentionDays: number;
  };
  semantics: {
    operationalSloOnly: true;
    explicitRouteOptInRequired: true;
    noCausalAttribution: true;
    noDealOutcomeInference: true;
    noCrmMutation: true;
    insufficientEvidenceCannotOpenIncident: true;
  };
}

export interface RecommendationDeliverySloEvaluationSummary {
  evaluatedPolicies: number;
  meeting: number;
  breaching: number;
  breached: number;
  recovering: number;
  insufficientData: number;
  openedIncidents: number;
  resolvedIncidents: number;
  remindersQueued: number;
  notificationsQueued: number;
  errors: number;
}

export interface RecommendationDeliverySloRoutingSnapshot {
  match: RecommendationFollowupRoutingMatch;
  eventType: RecommendationDeliverySloEventType;
  summary: string;
}
