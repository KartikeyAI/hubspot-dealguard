import type { HubSpotClient } from './hubspot.js';
import type {
  EngagementCallMetadata,
  EngagementEmailMetadata,
  EngagementMeetingMetadata,
  EngagementMetadataData,
} from './engagement-metadata-types.js';

export const ENGAGEMENT_EMAIL_PROPERTIES = [
  'hs_timestamp',
  'hs_email_direction',
  'hs_email_status',
  'hubspot_owner_id',
] as const;

export const ENGAGEMENT_CALL_PROPERTIES = [
  'hs_timestamp',
  'hs_call_direction',
  'hs_call_status',
  'hs_call_disposition',
  'hs_call_duration',
  'hubspot_owner_id',
] as const;

export const ENGAGEMENT_MEETING_PROPERTIES = [
  'hs_timestamp',
  'hs_meeting_start_time',
  'hs_meeting_end_time',
  'hs_meeting_outcome',
  'hubspot_owner_id',
] as const;

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const MEETING_FUTURE_HORIZON_DAYS = 180;
const MAX_EMAILS = 200;
const MAX_CALLS = 100;
const MAX_MEETINGS = 100;

interface ActivityObject {
  id: string;
  properties: Record<string, string | null | undefined>;
  updatedAt?: string;
}

interface ActivitySearchResponse {
  total?: number;
  results?: ActivityObject[];
  paging?: { next?: { after?: string } };
}

interface InternalHubSpotClient {
  request<T>(path: string, init?: RequestInit, retry?: boolean): Promise<T>;
}

interface SearchResult {
  records: ActivityObject[];
  truncated: boolean;
}

function normalizedTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nullableText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedEmailDirection(value: string | null | undefined): EngagementEmailMetadata['direction'] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'INCOMING_EMAIL') return 'inbound';
  if (normalized === 'EMAIL') return 'outbound';
  if (normalized === 'FORWARDED_EMAIL') return 'forwarded';
  return 'unknown';
}

function normalizedCallDirection(value: string | null | undefined): EngagementCallMetadata['direction'] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'INBOUND') return 'inbound';
  if (normalized === 'OUTBOUND') return 'outbound';
  return 'unknown';
}

function numericValue(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function searchActivities(
  internal: InternalHubSpotClient,
  objectType: 'emails' | 'calls' | 'meetings',
  dealId: string,
  properties: readonly string[],
  fromMs: number,
  toMs: number,
  limit: number,
): Promise<SearchResult> {
  const response = await internal.request<ActivitySearchResponse>(
    `/crm/objects/2026-03/${objectType}/search`,
    {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{
          filters: [
            { propertyName: 'associations.deal', operator: 'EQ', value: dealId },
            { propertyName: 'hs_timestamp', operator: 'GTE', value: String(fromMs) },
            { propertyName: 'hs_timestamp', operator: 'LTE', value: String(toMs) },
          ],
        }],
        limit,
        properties: [...properties],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
      }),
    },
  );
  const records = (response.results ?? []).slice(0, limit);
  const total = Number(response.total ?? records.length);
  return {
    records,
    truncated: Boolean(response.paging?.next) || total > records.length || (response.results?.length ?? 0) > limit,
  };
}

function emailRecords(records: ActivityObject[]): EngagementEmailMetadata[] {
  return records.map((record) => ({
    id: record.id,
    timestamp: normalizedTimestamp(record.properties.hs_timestamp),
    direction: normalizedEmailDirection(record.properties.hs_email_direction),
    status: nullableText(record.properties.hs_email_status)?.toUpperCase() ?? null,
    ownerId: nullableText(record.properties.hubspot_owner_id),
    updatedAt: normalizedTimestamp(record.updatedAt),
  }));
}

function callRecords(records: ActivityObject[]): EngagementCallMetadata[] {
  return records.map((record) => ({
    id: record.id,
    timestamp: normalizedTimestamp(record.properties.hs_timestamp),
    direction: normalizedCallDirection(record.properties.hs_call_direction),
    status: nullableText(record.properties.hs_call_status)?.toUpperCase() ?? null,
    disposition: nullableText(record.properties.hs_call_disposition),
    durationMs: numericValue(record.properties.hs_call_duration),
    ownerId: nullableText(record.properties.hubspot_owner_id),
    updatedAt: normalizedTimestamp(record.updatedAt),
  }));
}

function meetingRecords(records: ActivityObject[]): EngagementMeetingMetadata[] {
  return records.map((record) => ({
    id: record.id,
    timestamp: normalizedTimestamp(record.properties.hs_timestamp),
    startAt: normalizedTimestamp(record.properties.hs_meeting_start_time ?? record.properties.hs_timestamp),
    endAt: normalizedTimestamp(record.properties.hs_meeting_end_time),
    outcome: nullableText(record.properties.hs_meeting_outcome)?.toUpperCase().replaceAll(' ', '_') ?? null,
    ownerId: nullableText(record.properties.hubspot_owner_id),
    updatedAt: normalizedTimestamp(record.updatedAt),
  }));
}

export async function loadEngagementMetadata(
  client: HubSpotClient,
  dealId: string,
  now = Date.now(),
): Promise<EngagementMetadataData> {
  const internal = client as unknown as InternalHubSpotClient;
  const windowStartedAt = now - WINDOW_DAYS * DAY_MS;
  const meetingHorizonAt = now + MEETING_FUTURE_HORIZON_DAYS * DAY_MS;
  const settled = await Promise.allSettled([
    searchActivities(internal, 'emails', dealId, ENGAGEMENT_EMAIL_PROPERTIES, windowStartedAt, now, MAX_EMAILS),
    searchActivities(internal, 'calls', dealId, ENGAGEMENT_CALL_PROPERTIES, windowStartedAt, now, MAX_CALLS),
    searchActivities(internal, 'meetings', dealId, ENGAGEMENT_MEETING_PROPERTIES, windowStartedAt, meetingHorizonAt, MAX_MEETINGS),
  ] as const);

  const emailResult = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const callResult = settled[1].status === 'fulfilled' ? settled[1].value : null;
  const meetingResult = settled[2].status === 'fulfilled' ? settled[2].value : null;
  if (!emailResult && !callResult && !meetingResult) {
    throw new Error('HubSpot activity metadata endpoints were unavailable for this deal.');
  }

  const limitations: string[] = [];
  if (!emailResult) limitations.push('Email metadata was unavailable for this evidence refresh.');
  if (!callResult) limitations.push('Call metadata was unavailable for this evidence refresh.');
  if (!meetingResult) limitations.push('Meeting metadata was unavailable for this evidence refresh.');
  if (emailResult?.truncated) limitations.push(`Email metadata is bounded to the ${MAX_EMAILS} most recently returned associated records.`);
  if (callResult?.truncated) limitations.push(`Call metadata is bounded to the ${MAX_CALLS} most recently returned associated records.`);
  if (meetingResult?.truncated) limitations.push(`Meeting metadata is bounded to the ${MAX_MEETINGS} most recently returned associated records.`);

  return {
    emails: emailRecords(emailResult?.records ?? []),
    calls: callRecords(callResult?.records ?? []),
    meetings: meetingRecords(meetingResult?.records ?? []),
    availability: {
      emails: Boolean(emailResult),
      calls: Boolean(callResult),
      meetings: Boolean(meetingResult),
    },
    truncated: {
      emails: Boolean(emailResult?.truncated),
      calls: Boolean(callResult?.truncated),
      meetings: Boolean(meetingResult?.truncated),
    },
    fetchedAt: new Date(now).toISOString(),
    windowStartedAt: new Date(windowStartedAt).toISOString(),
    meetingHorizonAt: new Date(meetingHorizonAt).toISOString(),
    limitations,
  };
}
