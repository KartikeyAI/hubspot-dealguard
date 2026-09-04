# DealGuard Metadata-Only Engagement Intelligence

This capability adds deterministic engagement evidence to the DealGuard record experience without processing communication content. It uses structured HubSpot activity metadata associated with the current deal and feeds the result into the unified Deal Brief and Recommended Actions surfaces.

## Purpose

The engagement view answers operational questions such as:

- When was the most recent buyer-side activity recorded?
- Is the latest outbound email still waiting for a later inbound email?
- Is activity cadence accelerating, stable, declining, or inactive?
- Are recent completed calls or meetings recorded?
- Is a future buyer checkpoint scheduled before the current close date?
- Are failed emails or meeting no-shows weakening the current engagement pattern?
- What should the deal owner or manager do next?

The capability does not claim to determine what the buyer thinks or whether the deal will close.

## Evidence window

The default evidence window is 90 days. Scheduled meetings may be read up to 180 days in the future so DealGuard can determine whether a future checkpoint exists.

On demand, DealGuard performs three association-filtered HubSpot searches:

- `/crm/objects/2026-03/emails/search`
- `/crm/objects/2026-03/calls/search`
- `/crm/objects/2026-03/meetings/search`

Each search is filtered to the current deal through `associations.deal` and is bounded independently:

- up to 200 email records;
- up to 100 call records;
- up to 100 meeting records.

If an activity type exceeds its bounded limit, the response is marked truncated and confidence is capped.

## Data minimisation

### Email properties

- `hs_timestamp`
- `hs_email_direction`
- `hs_email_status`
- `hubspot_owner_id`

### Call properties

- `hs_timestamp`
- `hs_call_direction`
- `hs_call_status`
- `hs_call_disposition`
- `hs_call_duration`
- `hubspot_owner_id`

### Meeting properties

- `hs_timestamp`
- `hs_meeting_start_time`
- `hs_meeting_end_time`
- `hs_meeting_outcome`
- `hubspot_owner_id`

The implementation does not request or process:

- email subjects, text, HTML, headers, sender or recipient addresses;
- meeting titles, descriptions, internal notes, or attendee text;
- call bodies, titles, phone numbers, transcriptions, or recording URLs;
- notes, attachments, message content, or sentiment.

No new customer activity dataset is persisted in DealGuard. The evaluated result exists in the bounded record-enrichment response and its existing short-lived cache.

## Output contract

`intelligence.engagement` contains:

- `status`: `active`, `watch`, `disengaged`, or `insufficient_data`;
- `score`: deterministic metadata score from 0 to 100, or `null` when evidence is insufficient;
- `confidence`: `high`, `medium`, or `low`;
- most recent buyer-side, inbound-email, outbound-email, completed-call, and completed-meeting timestamps;
- next scheduled meeting;
- outbound-without-later-inbound response gap;
- email, call, and meeting counts;
- 14-day activity cadence and eight-week active-week count;
- email reciprocity based only on direction counts;
- activity-type coverage and truncation state;
- explainable signals and limitations.

`intelligence.engagementActions` contains owned, due-dated, evidence-backed actions. These actions are merged into the general DealGuard action queue and can include:

- verify engagement logging and deal associations;
- resolve a seven- or fourteen-day outbound response gap;
- review buyer-side activity older than 30 or 60 days;
- recover a meeting no-show;
- schedule a buyer checkpoint before the current close date;
- restore a declining activity cadence;
- verify a failed or bounced communication channel.

## Semantics

The engagement score is a deterministic review signal. It considers:

- buyer-side activity recency;
- unanswered outbound-email age;
- recent completed calls and meetings;
- future meeting coverage;
- directional email balance;
- activity cadence;
- failed or bounced emails;
- meeting no-shows;
- evidence availability and truncation.

It is not:

- buyer intent;
- sentiment or communication quality;
- a win probability;
- a forecast category;
- expected financial loss;
- an AI-generated interpretation of communications.

An absence of associated activity may reflect logging or association gaps. DealGuard therefore classifies no evidence as `insufficient_data`, not as proof of buyer disengagement.

## Deal Brief integration

Engagement contributes up to 20% of the expanded Deal Brief evidence-coverage model. The pre-existing readiness, momentum, close-date, and relationship model contributes the remaining 80% proportionally.

Negative engagement signals can increase attention priority and may move the brief to `watch` or `intervention_required`. Positive engagement signals can appear in the Deal Brief, but they do not override critical readiness or process evidence.

When engagement metadata is unavailable, the existing Deal Brief still renders and reports engagement as a missing evidence dimension.

## Runtime boundary

Engagement enrichment runs only for:

- a deal record opened with a recent assessment;
- an explicit record refresh.

It does not run during:

- full portal scans;
- scheduled scans;
- webhook assessments;
- workflow actions.

The existing 60-second record-enrichment cache and in-flight request deduplication are reused. Email, call, and meeting failures are isolated with `Promise.allSettled`, so one unavailable activity type does not remove the other evidence or the deterministic readiness result.

## Permissions

This slice adds no OAuth scope. HubSpot currently allows the email, call, and meeting activity APIs to be read using `crm.objects.contacts.read`, which DealGuard already requests. The implementation also uses the existing deal read permission for the current deal and close date.

## HubSpot surfaces

- **DealGuard — Deal Brief:** adds the engagement dimension and engagement-backed risk or positive evidence.
- **DealGuard — Engagement Evidence:** provides the detailed metadata view.
- **DealGuard — Recommended Actions:** includes engagement interventions alongside readiness, momentum, close-date, and relationship actions.

## Deployment dependency

This is a stacked slice. Production deployment requires, in order:

1. PR #17 and migration `0015_trustworthy_intelligence_currency.sql`;
2. PR #18 for momentum and close-date credibility;
3. PR #19 for buyer-committee coverage;
4. PR #20 for the unified Deal Brief;
5. this metadata-only engagement slice.
