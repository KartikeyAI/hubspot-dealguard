import type { EngagementAnalysis } from './engagement-analysis.js';
import type { EngagementMetadataData, EngagementSignal } from './engagement-metadata-types.js';
import { daysSince, iso, mostRecent, timestamp } from './engagement-metadata-utils.js';

export function buildEngagementSignals(
  data: EngagementMetadataData,
  analysis: EngagementAnalysis,
  now = Date.now(),
): EngagementSignal[] {
  const {
    evidenceCount,
    lastInboundEmail,
    emailResponseGapDays,
    unansweredOutboundSince,
    lastBuyerActivityAgeDays,
    lastBuyerActivity,
    lastCompletedMeeting,
    nextScheduledMeeting,
    reciprocityState,
    inboundEmails,
    outboundEmails,
    cadenceState,
    noShowMeetings,
    failedOrBouncedEmails,
    coverage,
  } = analysis;
  const signals: EngagementSignal[] = [];

  if (evidenceCount === 0) {
    signals.push({
      code: 'no_associated_activity_metadata',
      label: 'No associated activity metadata',
      direction: 'neutral',
      severity: 'warning',
      detail: 'No email, call, or meeting metadata was found for this deal in the bounded evidence window.',
      observedAt: data.fetchedAt,
      evidenceCodes: ['activity_metadata_count'],
    });
  }
  if (lastInboundEmail !== null && (daysSince(lastInboundEmail, now) ?? 999) <= 14) {
    signals.push({
      code: 'recent_inbound_email',
      label: 'Recent inbound email',
      direction: 'positive',
      severity: 'info',
      detail: `An inbound email is recorded within the last ${Math.max(1, Math.ceil(daysSince(lastInboundEmail, now) ?? 0))} day(s).`,
      observedAt: iso(lastInboundEmail),
      evidenceCodes: ['last_inbound_email_at'],
    });
  }
  if (emailResponseGapDays !== null && emailResponseGapDays >= 7) {
    signals.push({
      code: emailResponseGapDays >= 14 ? 'outbound_without_reply_14d' : 'outbound_without_reply_7d',
      label: 'Outbound email without a later logged reply',
      direction: 'negative',
      severity: emailResponseGapDays >= 21 ? 'critical' : 'warning',
      detail: `The latest outbound email is ${emailResponseGapDays} days old and no later inbound email is associated with the deal.`,
      observedAt: iso(unansweredOutboundSince),
      evidenceCodes: ['last_outbound_email_at', 'last_inbound_email_at'],
    });
  }
  if (lastBuyerActivityAgeDays !== null && lastBuyerActivityAgeDays >= 30) {
    signals.push({
      code: lastBuyerActivityAgeDays >= 60 ? 'no_buyer_activity_60d' : 'no_buyer_activity_30d',
      label: 'Buyer-side activity is aging',
      direction: 'negative',
      severity: lastBuyerActivityAgeDays >= 60 ? 'critical' : 'warning',
      detail: `The most recent inbound email, inbound completed call, or completed meeting is ${lastBuyerActivityAgeDays} days old.`,
      observedAt: iso(lastBuyerActivity),
      evidenceCodes: ['last_buyer_activity_at'],
    });
  }
  if (lastCompletedMeeting !== null && (daysSince(lastCompletedMeeting, now) ?? 999) <= 30) {
    signals.push({
      code: 'recent_completed_meeting',
      label: 'Recent completed meeting',
      direction: 'positive',
      severity: 'info',
      detail: 'A completed meeting is recorded within the last 30 days.',
      observedAt: iso(lastCompletedMeeting),
      evidenceCodes: ['last_completed_meeting_at'],
    });
  }
  if (nextScheduledMeeting !== null) {
    signals.push({
      code: 'next_meeting_scheduled',
      label: 'Future meeting is scheduled',
      direction: 'positive',
      severity: 'info',
      detail: `A meeting is scheduled for ${new Date(nextScheduledMeeting).toISOString()}.`,
      observedAt: iso(nextScheduledMeeting),
      evidenceCodes: ['next_scheduled_meeting_at'],
    });
  }
  if (reciprocityState.status === 'balanced') {
    signals.push({
      code: 'bidirectional_email_activity',
      label: 'Bidirectional email activity',
      direction: 'positive',
      severity: 'info',
      detail: `${inboundEmails.length} inbound and ${outboundEmails.length} outbound emails are recorded in the evidence window.`,
      observedAt: iso(mostRecent([analysis.lastInboundEmail, analysis.lastOutboundEmail])),
      evidenceCodes: ['inbound_email_count', 'outbound_email_count'],
    });
  } else if (reciprocityState.status === 'outbound_heavy' && outboundEmails.length >= 2) {
    signals.push({
      code: 'outbound_heavy_email_activity',
      label: 'Email activity is outbound-heavy',
      direction: 'negative',
      severity: 'warning',
      detail: `${outboundEmails.length} outbound emails and ${inboundEmails.length} inbound emails are recorded in the evidence window.`,
      observedAt: iso(analysis.lastOutboundEmail),
      evidenceCodes: ['inbound_email_count', 'outbound_email_count'],
    });
  }
  if (cadenceState.trend === 'accelerating') {
    signals.push({
      code: 'engagement_cadence_accelerating',
      label: 'Activity cadence is accelerating',
      direction: 'positive',
      severity: 'info',
      detail: `${cadenceState.recent14Days} material activities were recorded in the last 14 days versus ${cadenceState.previous14Days} in the prior 14 days.`,
      observedAt: data.fetchedAt,
      evidenceCodes: ['activity_cadence_14d'],
    });
  } else if (cadenceState.trend === 'declining') {
    signals.push({
      code: 'engagement_cadence_declining',
      label: 'Activity cadence is declining',
      direction: 'negative',
      severity: 'warning',
      detail: `${cadenceState.recent14Days} material activities were recorded in the last 14 days versus ${cadenceState.previous14Days} in the prior 14 days.`,
      observedAt: data.fetchedAt,
      evidenceCodes: ['activity_cadence_14d'],
    });
  }
  if (noShowMeetings.length > 0) {
    signals.push({
      code: 'meeting_no_show_recorded',
      label: 'Meeting no-show recorded',
      direction: 'negative',
      severity: noShowMeetings.length >= 2 ? 'critical' : 'warning',
      detail: `${noShowMeetings.length} meeting no-show${noShowMeetings.length === 1 ? '' : 's'} are recorded in the evidence window.`,
      observedAt: iso(mostRecent(noShowMeetings.map((item) => timestamp(item.startAt ?? item.timestamp)))),
      evidenceCodes: ['meeting_no_show_count'],
    });
  }
  if (failedOrBouncedEmails.length > 0) {
    signals.push({
      code: 'failed_or_bounced_email',
      label: 'Failed or bounced email recorded',
      direction: 'negative',
      severity: 'warning',
      detail: `${failedOrBouncedEmails.length} failed or bounced outbound email${failedOrBouncedEmails.length === 1 ? '' : 's'} are associated with the deal.`,
      observedAt: iso(mostRecent(failedOrBouncedEmails.map((item) => timestamp(item.timestamp)))),
      evidenceCodes: ['failed_or_bounced_email_count'],
    });
  }
  if (coverage.truncated) {
    signals.push({
      code: 'engagement_metadata_truncated',
      label: 'Engagement evidence is bounded',
      direction: 'neutral',
      severity: 'info',
      detail: 'One or more activity types exceeded the bounded on-demand evidence limit.',
      observedAt: data.fetchedAt,
      evidenceCodes: ['engagement_truncated'],
    });
  }

  return signals;
}
