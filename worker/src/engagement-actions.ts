import type { EngagementAnalysis } from './engagement-analysis.js';
import type { DecisionAction } from './deal-momentum-types.js';
import {
  DAY_MS,
  decisionAction,
  round,
  sortedActions,
  timestamp,
} from './engagement-metadata-utils.js';
import type { NormalizedDeal } from './types.js';

export function buildEngagementActions(
  analysis: EngagementAnalysis,
  deal: NormalizedDeal,
  now = Date.now(),
): DecisionAction[] {
  const actions: DecisionAction[] = [];
  const {
    evidenceCount,
    emailResponseGapDays,
    lastBuyerActivityAgeDays,
    noShowMeetings,
    nextScheduledMeeting,
    cadenceState,
    failedOrBouncedEmails,
  } = analysis;

  if (evidenceCount === 0) {
    actions.push(decisionAction(
      'verify_engagement_logging',
      'Verify engagement logging',
      'Confirm that recent customer emails, calls, and meetings are logged and associated with this deal.',
      'medium',
      'No associated activity metadata is available in the 90-day evidence window.',
      'deal_owner',
      48,
      ['no_associated_activity_metadata'],
      now,
    ));
  }
  if (emailResponseGapDays !== null && emailResponseGapDays >= 14) {
    actions.push(decisionAction(
      'reengage_or_requalify_response_gap',
      'Resolve the buyer-response gap',
      'Re-engage the buyer through an appropriate channel, confirm whether the opportunity remains active, and update the next committed step.',
      'high',
      `The latest outbound email is ${emailResponseGapDays} days old with no later inbound email associated with the deal.`,
      'deal_owner',
      24,
      ['outbound_without_reply_14d'],
      now,
    ));
  } else if (emailResponseGapDays !== null && emailResponseGapDays >= 7) {
    actions.push(decisionAction(
      'follow_up_response_gap',
      'Follow up on the response gap',
      'Follow up with the buyer and record a dated next step or requalification decision.',
      'medium',
      `The latest outbound email is ${emailResponseGapDays} days old with no later inbound email associated with the deal.`,
      'deal_owner',
      48,
      ['outbound_without_reply_7d'],
      now,
    ));
  }
  if (lastBuyerActivityAgeDays !== null && lastBuyerActivityAgeDays >= 30) {
    actions.push(decisionAction(
      'review_aged_buyer_activity',
      'Review aged buyer-side activity',
      'Confirm current buyer participation and either restart a mutual action plan, adjust the close plan, or requalify the deal.',
      lastBuyerActivityAgeDays >= 60 ? 'high' : 'medium',
      `The most recent buyer-side activity is ${lastBuyerActivityAgeDays} days old.`,
      lastBuyerActivityAgeDays >= 60 ? 'manager' : 'deal_owner',
      lastBuyerActivityAgeDays >= 60 ? 24 : 48,
      [lastBuyerActivityAgeDays >= 60 ? 'no_buyer_activity_60d' : 'no_buyer_activity_30d'],
      now,
    ));
  }
  if (noShowMeetings.length > 0 && nextScheduledMeeting === null) {
    actions.push(decisionAction(
      'recover_meeting_no_show',
      'Recover the missed meeting',
      'Confirm the reason for the no-show and schedule a new buyer checkpoint or explicitly requalify the opportunity.',
      noShowMeetings.length >= 2 ? 'high' : 'medium',
      `${noShowMeetings.length} meeting no-show${noShowMeetings.length === 1 ? '' : 's'} are recorded and no future meeting is scheduled.`,
      'deal_owner',
      24,
      ['meeting_no_show_recorded'],
      now,
    ));
  }
  const closeDate = timestamp(deal.properties.closedate);
  const daysToClose = closeDate === null ? null : round((closeDate - now) / DAY_MS, 1);
  if (!deal.stage?.isClosed && daysToClose !== null && daysToClose >= 0 && daysToClose <= 30 && nextScheduledMeeting === null) {
    actions.push(decisionAction(
      'schedule_buyer_checkpoint_before_close',
      'Schedule a buyer checkpoint before close',
      'Schedule and record a buyer checkpoint before the current close date, or revise the close plan if no meeting is appropriate.',
      'medium',
      `The close date is ${daysToClose} days away and no future meeting is associated with the deal.`,
      'deal_owner',
      48,
      ['close_date_near', 'next_scheduled_meeting_missing'],
      now,
    ));
  }
  if (cadenceState.trend === 'declining') {
    actions.push(decisionAction(
      'restore_engagement_cadence',
      'Restore engagement cadence',
      'Agree a dated mutual next step and confirm the cadence required to reach the current close plan.',
      'medium',
      `Material activity declined from ${cadenceState.previous14Days} events in the prior 14 days to ${cadenceState.recent14Days} in the latest 14 days.`,
      'deal_owner',
      48,
      ['engagement_cadence_declining'],
      now,
    ));
  }
  if (failedOrBouncedEmails.length > 0) {
    actions.push(decisionAction(
      'verify_communication_channel',
      'Verify the communication channel',
      'Confirm that the current customer communication channel is valid and record an alternative contact path when necessary.',
      'medium',
      `${failedOrBouncedEmails.length} failed or bounced email${failedOrBouncedEmails.length === 1 ? '' : 's'} are associated with the deal.`,
      'deal_owner',
      48,
      ['failed_or_bounced_email'],
      now,
    ));
  }
  return sortedActions(actions);
}
