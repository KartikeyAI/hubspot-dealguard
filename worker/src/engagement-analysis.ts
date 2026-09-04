import type {
  EngagementCallMetadata,
  EngagementEmailMetadata,
  EngagementMeetingMetadata,
  EngagementMetadataData,
  EngagementMetadataIntelligence,
} from './engagement-metadata-types.js';
import {
  DAY_MS,
  cadence,
  clamp,
  completedCall,
  daysSince,
  materialOutboundEmail,
  mostRecent,
  nextFuture,
  normalize,
  reciprocity,
  timestamp,
} from './engagement-metadata-utils.js';

export interface EngagementAnalysis {
  inboundEmails: EngagementEmailMetadata[];
  outboundEmails: EngagementEmailMetadata[];
  forwardedEmails: EngagementEmailMetadata[];
  failedOrBouncedEmails: EngagementEmailMetadata[];
  completedCalls: EngagementCallMetadata[];
  inboundCalls: EngagementCallMetadata[];
  outboundCalls: EngagementCallMetadata[];
  completedMeetings: EngagementMeetingMetadata[];
  scheduledMeetings: EngagementMeetingMetadata[];
  noShowMeetings: EngagementMeetingMetadata[];
  canceledMeetings: EngagementMeetingMetadata[];
  lastInboundEmail: number | null;
  lastOutboundEmail: number | null;
  lastCompletedCall: number | null;
  lastCompletedMeeting: number | null;
  nextScheduledMeeting: number | null;
  lastBuyerActivity: number | null;
  unansweredOutboundSince: number | null;
  emailResponseGapDays: number | null;
  lastBuyerActivityAgeDays: number | null;
  materialEventTimes: number[];
  cadenceState: EngagementMetadataIntelligence['engagement']['cadence'];
  reciprocityState: EngagementMetadataIntelligence['engagement']['reciprocity'];
  coverage: EngagementMetadataIntelligence['engagement']['coverage'];
  evidenceCount: number;
  score: number | null;
  status: EngagementMetadataIntelligence['engagement']['status'];
  confidence: EngagementMetadataIntelligence['engagement']['confidence'];
  summary: string;
}

export function analyzeEngagement(
  data: EngagementMetadataData,
  now = Date.now(),
): EngagementAnalysis {
  const inboundEmails = data.emails.filter((item) => item.direction === 'inbound');
  const outboundEmails = data.emails.filter(materialOutboundEmail);
  const forwardedEmails = data.emails.filter((item) => item.direction === 'forwarded');
  const failedOrBouncedEmails = data.emails.filter((item) => ['FAILED', 'BOUNCED'].includes(normalize(item.status)));

  const completedCalls = data.calls.filter(completedCall);
  const inboundCalls = completedCalls.filter((item) => item.direction === 'inbound');
  const outboundCalls = completedCalls.filter((item) => item.direction === 'outbound');

  const completedMeetings = data.meetings.filter((item) => normalize(item.outcome) === 'COMPLETED');
  const scheduledMeetings = data.meetings.filter((item) =>
    normalize(item.outcome) === 'SCHEDULED' && (timestamp(item.startAt ?? item.timestamp) ?? 0) >= now,
  );
  const noShowMeetings = data.meetings.filter((item) => ['NO_SHOW', 'NOSHOW'].includes(normalize(item.outcome)));
  const canceledMeetings = data.meetings.filter((item) => ['CANCELED', 'CANCELLED'].includes(normalize(item.outcome)));

  const lastInboundEmail = mostRecent(inboundEmails.map((item) => timestamp(item.timestamp)));
  const lastOutboundEmail = mostRecent(outboundEmails.map((item) => timestamp(item.timestamp)));
  const lastCompletedInboundCall = mostRecent(inboundCalls.map((item) => timestamp(item.timestamp)));
  const lastCompletedCall = mostRecent(completedCalls.map((item) => timestamp(item.timestamp)));
  const lastCompletedMeeting = mostRecent(completedMeetings.map((item) => timestamp(item.startAt ?? item.timestamp)));
  const nextScheduledMeeting = nextFuture(scheduledMeetings.map((item) => timestamp(item.startAt ?? item.timestamp)), now);
  const lastBuyerActivity = mostRecent([lastInboundEmail, lastCompletedInboundCall, lastCompletedMeeting]);

  const unansweredOutboundSince = lastOutboundEmail !== null && (lastInboundEmail === null || lastOutboundEmail > lastInboundEmail)
    ? lastOutboundEmail
    : null;
  const emailResponseGapDays = daysSince(unansweredOutboundSince, now);
  const lastBuyerActivityAgeDays = daysSince(lastBuyerActivity, now);

  const materialEventTimes = [
    ...inboundEmails.map((item) => timestamp(item.timestamp)),
    ...outboundEmails.map((item) => timestamp(item.timestamp)),
    ...completedCalls.map((item) => timestamp(item.timestamp)),
    ...completedMeetings.map((item) => timestamp(item.startAt ?? item.timestamp)),
  ].filter((value): value is number => value !== null && value <= now);
  const cadenceState = cadence(materialEventTimes, now);
  const reciprocityState = reciprocity(inboundEmails.length, outboundEmails.length);
  const availabilityCount = Object.values(data.availability).filter(Boolean).length;
  const truncated = Object.values(data.truncated).some(Boolean);
  const coverage: EngagementMetadataIntelligence['engagement']['coverage'] = {
    emails: data.availability.emails,
    calls: data.availability.calls,
    meetings: data.availability.meetings,
    percent: Math.round((availabilityCount / 3) * 100),
    truncated,
    missingTypes: [
      ...(!data.availability.emails ? ['email' as const] : []),
      ...(!data.availability.calls ? ['call' as const] : []),
      ...(!data.availability.meetings ? ['meeting' as const] : []),
    ],
  };

  const evidenceCount = data.emails.length + data.calls.length + data.meetings.length;
  let score: number | null = null;
  if (evidenceCount > 0) {
    let value = 50;
    if (lastBuyerActivityAgeDays !== null) {
      if (lastBuyerActivityAgeDays <= 7) value += 20;
      else if (lastBuyerActivityAgeDays <= 14) value += 12;
      else if (lastBuyerActivityAgeDays <= 30) value += 3;
      else if (lastBuyerActivityAgeDays <= 60) value -= 12;
      else value -= 22;
    } else value -= 15;

    if (emailResponseGapDays !== null) {
      if (emailResponseGapDays >= 21) value -= 25;
      else if (emailResponseGapDays >= 14) value -= 18;
      else if (emailResponseGapDays >= 7) value -= 9;
      else if (emailResponseGapDays >= 4) value -= 4;
    }
    if (nextScheduledMeeting !== null && nextScheduledMeeting <= now + 30 * DAY_MS) value += 12;
    if (lastCompletedMeeting !== null && (daysSince(lastCompletedMeeting, now) ?? 999) <= 30) value += 10;
    if (lastCompletedCall !== null && (daysSince(lastCompletedCall, now) ?? 999) <= 14) value += 6;
    if (reciprocityState.status === 'balanced') value += 8;
    else if (reciprocityState.status === 'outbound_heavy') value -= 6;
    if (cadenceState.trend === 'accelerating') value += 8;
    else if (cadenceState.trend === 'steady') value += 2;
    else if (cadenceState.trend === 'declining') value -= 10;
    else if (cadenceState.trend === 'inactive') value -= 12;
    value -= Math.min(10, failedOrBouncedEmails.length * 4);
    value -= Math.min(15, noShowMeetings.length * 7);
    if (coverage.percent < 67) value -= 5;
    if (coverage.truncated) value -= 5;
    score = Math.round(clamp(value));
  }

  let status: EngagementMetadataIntelligence['engagement']['status'];
  if (score === null) status = 'insufficient_data';
  else if (score >= 70 && ((lastBuyerActivityAgeDays ?? 999) <= 14 || nextScheduledMeeting !== null)) status = 'active';
  else if (score < 40 || ((emailResponseGapDays ?? 0) >= 14 && (lastBuyerActivityAgeDays ?? 999) >= 30)) status = 'disengaged';
  else status = 'watch';

  const activeTypes = [data.emails.length > 0, data.calls.length > 0, data.meetings.length > 0].filter(Boolean).length;
  const confidence: EngagementMetadataIntelligence['engagement']['confidence'] =
    coverage.percent === 100 && !coverage.truncated && evidenceCount >= 8 && activeTypes >= 2
      ? 'high'
      : coverage.percent >= 67 && evidenceCount >= 3
        ? 'medium'
        : 'low';

  const summary = status === 'active'
    ? 'Recent buyer-side activity and current cadence support an active engagement pattern in the CRM metadata.'
    : status === 'disengaged'
      ? 'CRM activity metadata indicates a material response or recency gap that requires intervention.'
      : status === 'watch'
        ? 'Engagement metadata is mixed or weakening and should be reviewed before relying on the current close plan.'
        : 'There is not enough associated activity metadata to evaluate engagement reliably.';

  return {
    inboundEmails,
    outboundEmails,
    forwardedEmails,
    failedOrBouncedEmails,
    completedCalls,
    inboundCalls,
    outboundCalls,
    completedMeetings,
    scheduledMeetings,
    noShowMeetings,
    canceledMeetings,
    lastInboundEmail,
    lastOutboundEmail,
    lastCompletedCall,
    lastCompletedMeeting,
    nextScheduledMeeting,
    lastBuyerActivity,
    unansweredOutboundSince,
    emailResponseGapDays,
    lastBuyerActivityAgeDays,
    materialEventTimes,
    cadenceState,
    reciprocityState,
    coverage,
    evidenceCount,
    score,
    status,
    confidence,
    summary,
  };
}
