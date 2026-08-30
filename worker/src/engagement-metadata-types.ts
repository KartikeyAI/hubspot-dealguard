import type { DecisionAction } from './deal-momentum-types.js';
import type { IssueSeverity } from './types.js';

export type EngagementActivityType = 'email' | 'call' | 'meeting';

export interface EngagementEmailMetadata {
  id: string;
  timestamp: string | null;
  direction: 'inbound' | 'outbound' | 'forwarded' | 'unknown';
  status: string | null;
  ownerId: string | null;
  updatedAt: string | null;
}

export interface EngagementCallMetadata {
  id: string;
  timestamp: string | null;
  direction: 'inbound' | 'outbound' | 'unknown';
  status: string | null;
  disposition: string | null;
  durationMs: number | null;
  ownerId: string | null;
  updatedAt: string | null;
}

export interface EngagementMeetingMetadata {
  id: string;
  timestamp: string | null;
  startAt: string | null;
  endAt: string | null;
  outcome: string | null;
  ownerId: string | null;
  updatedAt: string | null;
}

export interface EngagementMetadataData {
  emails: EngagementEmailMetadata[];
  calls: EngagementCallMetadata[];
  meetings: EngagementMeetingMetadata[];
  availability: Record<'emails' | 'calls' | 'meetings', boolean>;
  truncated: Record<'emails' | 'calls' | 'meetings', boolean>;
  fetchedAt: string;
  windowStartedAt: string;
  meetingHorizonAt: string;
  limitations: string[];
}

export interface EngagementSignal {
  code: string;
  label: string;
  direction: 'positive' | 'negative' | 'neutral';
  severity: IssueSeverity;
  detail: string;
  observedAt: string | null;
  evidenceCodes: string[];
}

export interface EngagementCadence {
  recent14Days: number;
  previous14Days: number;
  activeWeeks8: number;
  trend: 'accelerating' | 'steady' | 'declining' | 'inactive' | 'insufficient_data';
}

export interface EngagementReciprocity {
  inboundEmailCount: number;
  outboundEmailCount: number;
  ratio: number | null;
  status: 'balanced' | 'outbound_heavy' | 'inbound_led' | 'unavailable';
}

export interface EngagementCoverage {
  emails: boolean;
  calls: boolean;
  meetings: boolean;
  percent: number;
  truncated: boolean;
  missingTypes: EngagementActivityType[];
}

export interface EngagementMetadataSummary {
  methodology: 'hubspot_activity_metadata';
  windowDays: 90;
  score: number | null;
  status: 'active' | 'watch' | 'disengaged' | 'insufficient_data';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  lastBuyerActivityAt: string | null;
  lastInboundEmailAt: string | null;
  lastOutboundEmailAt: string | null;
  unansweredOutboundSince: string | null;
  emailResponseGapDays: number | null;
  lastCompletedCallAt: string | null;
  lastCompletedMeetingAt: string | null;
  nextScheduledMeetingAt: string | null;
  counts: {
    inboundEmails: number;
    outboundEmails: number;
    forwardedEmails: number;
    failedOrBouncedEmails: number;
    inboundCalls: number;
    outboundCalls: number;
    completedCalls: number;
    completedMeetings: number;
    scheduledMeetings: number;
    noShowMeetings: number;
    canceledMeetings: number;
    totalMaterialActivities: number;
  };
  cadence: EngagementCadence;
  reciprocity: EngagementReciprocity;
  coverage: EngagementCoverage;
  signals: EngagementSignal[];
  fetchedAt: string;
  limitations: string[];
  contentProcessed: false;
  notBuyerIntent: true;
  notWinProbability: true;
  notSentimentAnalysis: true;
}

export interface EngagementMetadataIntelligence {
  engagement: EngagementMetadataSummary;
  engagementActions: DecisionAction[];
}
