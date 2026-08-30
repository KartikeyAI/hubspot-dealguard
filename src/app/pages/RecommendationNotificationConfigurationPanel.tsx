import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Input,
  LoadingSpinner,
  MultiSelect,
  NumberInput,
  Select,
  StatusTag,
  Text,
  Toggle,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const EVENT_OPTIONS = [
  { label: 'Manual recommendation follow-up', value: 'recommendation.followup.requested' },
  { label: 'Recommendation due soon', value: 'recommendation.policy.due_soon' },
  { label: 'Recommendation overdue', value: 'recommendation.policy.overdue' },
  { label: 'Recommendation manager escalation', value: 'recommendation.policy.escalated' },
];

type ChannelType = 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';
type Severity = 'info' | 'warning' | 'critical';
type Channel = {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  recipients: string[];
  createdAt: string;
  updatedAt: string;
};
type Route = {
  id: string;
  name: string;
  eventTypes: string[];
  minimumSeverity: Severity;
  pipelineIds: string[];
  teamIds: string[];
  ownerIds: string[];
  regionCodes: string[];
  channelIds: string[];
  directOwner: boolean;
  directManager: boolean;
  quietHoursCalendarId: string | null;
  escalationPolicyId: string | null;
  suppressionWindowMinutes: number;
  enabled: boolean;
};
type Calendar = {
  id: string;
  name: string;
  timezone: string;
  weeklySchedule: Record<string, { enabled?: boolean; start?: string; end?: string }>;
  holidays: string[];
};
type AlertConfiguration = { channels: Channel[]; routes: Route[]; calendars: Calendar[] };
type Access = { permissions: string[] };

type ChannelForm = {
  id: string | null;
  type: ChannelType;
  name: string;
  endpoint: string;
  recipients: string;
  signingSecret: string;
  enabled: boolean;
};
type RouteForm = {
  id: string | null;
  name: string;
  eventTypes: string[];
  minimumSeverity: Severity;
  channelIds: string[];
  quietHoursCalendarId: string;
  suppressionWindowMinutes: number;
  pipelineIds: string;
  teamIds: string;
  ownerIds: string;
  regionCodes: string;
  enabled: boolean;
};
type CalendarForm = {
  id: string | null;
  name: string;
  timezone: string;
  start: string;
  end: string;
  holidays: string;
};

const EMPTY_CHANNEL: ChannelForm = {
  id: null,
  type: 'slack_webhook',
  name: 'Recommendation alerts',
  endpoint: '',
  recipients: '',
  signingSecret: '',
  enabled: true,
};
const EMPTY_ROUTE: RouteForm = {
  id: null,
  name: 'Recommendation due-date routing',
  eventTypes: ['recommendation.policy.overdue'],
  minimumSeverity: 'warning',
  channelIds: [],
  quietHoursCalendarId: '',
  suppressionWindowMinutes: 1440,
  pipelineIds: '',
  teamIds: '',
  ownerIds: '',
  regionCodes: '',
  enabled: true,
};
const EMPTY_CALENDAR: CalendarForm = {
  id: null,
  name: 'Business hours',
  timezone: 'Asia/Kolkata',
  start: '09:00',
  end: '18:00',
  holidays: '',
};

function split(value: string): string[] {
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function channelTypeLabel(type: ChannelType): string {
  if (type === 'slack_webhook') return 'Slack webhook';
  if (type === 'teams_workflow') return 'Microsoft Teams workflow';
  if (type === 'email') return 'Email';
  return 'Signed webhook';
}

function editChannel(channel: Channel): ChannelForm {
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    endpoint: '',
    recipients: channel.recipients.join(', '),
    signingSecret: '',
    enabled: channel.enabled,
  };
}

function editRoute(route: Route): RouteForm {
  return {
    id: route.id,
    name: route.name,
    eventTypes: route.eventTypes,
    minimumSeverity: route.minimumSeverity,
    channelIds: route.channelIds,
    quietHoursCalendarId: route.quietHoursCalendarId ?? '',
    suppressionWindowMinutes: route.suppressionWindowMinutes,
    pipelineIds: route.pipelineIds.join(', '),
    teamIds: route.teamIds.join(', '),
    ownerIds: route.ownerIds.join(', '),
    regionCodes: route.regionCodes.join(', '),
    enabled: route.enabled,
  };
}

function editCalendar(calendar: Calendar): CalendarForm {
  const weekday = calendar.weeklySchedule.mon ?? {};
  return {
    id: calendar.id,
    name: calendar.name,
    timezone: calendar.timezone,
    start: weekday.start ?? '09:00',
    end: weekday.end ?? '18:00',
    holidays: calendar.holidays.join(', '),
  };
}

function businessWeek(start: string, end: string) {
  return {
    mon: { enabled: true, start, end },
    tue: { enabled: true, start, end },
    wed: { enabled: true, start, end },
    thu: { enabled: true, start, end },
    fri: { enabled: true, start, end },
    sat: { enabled: false },
    sun: { enabled: false },
  };
}

export function RecommendationNotificationConfigurationPanel({ enabled }: { enabled: boolean }) {
  const [configuration, setConfiguration] = useState<AlertConfiguration | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [channel, setChannel] = useState<ChannelForm>(EMPTY_CHANNEL);
  const [route, setRoute] = useState<RouteForm>(EMPTY_ROUTE);
  const [calendar, setCalendar] = useState<CalendarForm>(EMPTY_CALENDAR);
  const [generatedSecret, setGeneratedSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [working, setWorking] = useState<'channel' | 'route' | 'calendar' | 'delete' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useCallback(async (path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> } = {}) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      timeout: 15_000,
      ...(options.body ? { body: options.body } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'Notification configuration could not be updated.'));
    return payload;
  }, []);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setWorking('refresh');
    else setLoading(true);
    setError(null);
    try {
      const [nextAccess, nextConfiguration] = await Promise.all([
        request('/enterprise/access') as Promise<Access>,
        request('/enterprise/alerts') as Promise<AlertConfiguration>,
      ]);
      setAccess(nextAccess);
      setConfiguration(nextConfiguration);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Notification configuration could not be loaded.'));
    } finally {
      setLoading(false);
      setWorking(null);
    }
  }, [enabled, request]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void load(false);
  }, [enabled, load]);

  const canManage = Boolean(access?.permissions.includes('*') || access?.permissions.includes('alert.manage'));

  const saveChannel = useCallback(async () => {
    setWorking('channel');
    setError(null);
    setNotice(null);
    setGeneratedSecret(null);
    try {
      const path = channel.id ? `/enterprise/alerts/channels/${encodeURIComponent(channel.id)}` : '/enterprise/alerts/channels';
      const body: Record<string, unknown> = {
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        recipients: split(channel.recipients),
      };
      if (channel.endpoint.trim()) body.endpoint = channel.endpoint.trim();
      if (channel.signingSecret.trim()) body.signingSecret = channel.signingSecret.trim();
      const result = await request(path, { method: channel.id ? 'PUT' : 'POST', body });
      if (typeof result.signingSecret === 'string') setGeneratedSecret(result.signingSecret);
      setChannel(EMPTY_CHANNEL);
      setNotice('Notification channel saved.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null));
    } finally {
      setWorking(null);
    }
  }, [channel, load, request]);

  const deleteChannel = useCallback(async () => {
    if (!channel.id) return;
    setWorking('delete');
    setError(null);
    setNotice(null);
    try {
      await request(`/enterprise/alerts/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE' });
      setChannel(EMPTY_CHANNEL);
      setNotice('Notification channel deleted.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null));
    } finally {
      setWorking(null);
    }
  }, [channel.id, load, request]);

  const saveCalendar = useCallback(async () => {
    setWorking('calendar');
    setError(null);
    setNotice(null);
    try {
      const path = calendar.id ? `/enterprise/alerts/calendars/${encodeURIComponent(calendar.id)}` : '/enterprise/alerts/calendars';
      await request(path, {
        method: calendar.id ? 'PUT' : 'POST',
        body: {
          name: calendar.name,
          timezone: calendar.timezone,
          weeklySchedule: businessWeek(calendar.start, calendar.end),
          holidays: split(calendar.holidays),
        },
      });
      setCalendar(EMPTY_CALENDAR);
      setNotice('Business-hours calendar saved.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null));
    } finally {
      setWorking(null);
    }
  }, [calendar, load, request]);

  const saveRoute = useCallback(async (override?: Partial<RouteForm>) => {
    const value = { ...route, ...override };
    setWorking('route');
    setError(null);
    setNotice(null);
    try {
      const path = value.id ? `/enterprise/alerts/routes/${encodeURIComponent(value.id)}` : '/enterprise/alerts/routes';
      await request(path, {
        method: value.id ? 'PUT' : 'POST',
        body: {
          name: value.name,
          eventTypes: value.eventTypes,
          minimumSeverity: value.minimumSeverity,
          channelIds: value.channelIds,
          pipelineIds: split(value.pipelineIds),
          teamIds: split(value.teamIds),
          ownerIds: split(value.ownerIds),
          regionCodes: split(value.regionCodes),
          quietHoursCalendarId: value.quietHoursCalendarId || null,
          suppressionWindowMinutes: value.suppressionWindowMinutes,
          directOwner: false,
          directManager: false,
          enabled: value.enabled,
        },
      });
      setRoute(EMPTY_ROUTE);
      setNotice(value.enabled ? 'Notification route saved and enabled.' : 'Notification route saved as disabled.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null));
    } finally {
      setWorking(null);
    }
  }, [load, request, route]);

  const channelOptions = useMemo(
    () => (configuration?.channels ?? []).filter((item) => item.enabled).map((item) => ({ label: `${item.name} · ${channelTypeLabel(item.type)}`, value: item.id })),
    [configuration],
  );
  const calendarOptions = useMemo(
    () => [{ label: 'No quiet-hours calendar', value: '' }, ...(configuration?.calendars ?? []).map((item) => ({ label: `${item.name} · ${item.timezone}`, value: item.id }))],
    [configuration],
  );

  if (!enabled) return <Card><Flex direction="column" gap="small"><Heading>Notification routes & quiet hours</Heading><Text>Enterprise workspaces can configure encrypted Slack, Microsoft Teams, email, and signed webhook channels.</Text></Flex></Card>;
  if (loading) return <LoadingSpinner label="Loading notification routes" />;

  const channels = configuration?.channels ?? [];
  const routes = configuration?.routes ?? [];
  const calendars = configuration?.calendars ?? [];

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center"><Flex direction="column" gap="extra-small"><Heading>Notification routes & quiet hours</Heading><Text>Configure reusable encrypted destinations before attaching them to recommendation follow-up and SLA policies.</Text></Flex><Button variant="secondary" disabled={working !== null} onClick={() => void load(true)}>{working === 'refresh' ? 'Refreshing…' : 'Refresh routing'}</Button></Flex>
    {error ? <Alert title="Notification configuration failed" variant="danger">{error}</Alert> : null}
    {notice ? <Alert title="Notification configuration updated" variant="success">{notice}</Alert> : null}
    {!canManage ? <Alert title="Notification configuration is read only" variant="info">The alert.manage permission is required to create or update channels, calendars, and routes.</Alert> : null}
    {generatedSecret ? <Alert title="Store the webhook signing secret now" variant="warning">{generatedSecret}</Alert> : null}

    <Flex direction="column" gap="small">
      <Heading>Reusable channels</Heading>
      {channels.length === 0 ? <Text>No notification channel is configured.</Text> : channels.map((item) => <Card key={item.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center"><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><StatusTag variant={item.enabled ? 'success' : 'default'}>{item.enabled ? 'Enabled' : 'Disabled'}</StatusTag></Flex><Text variant="microcopy">{channelTypeLabel(item.type)}{item.type === 'email' ? ` · ${item.recipients.length} recipient(s)` : ''}</Text><Button variant="secondary" disabled={!canManage || working !== null} onClick={() => setChannel(editChannel(item))}>Edit channel</Button></Flex></Card>)}
      <Select name="recommendation-channel-type" label="Channel type" value={channel.type} options={[{ label: 'Slack webhook', value: 'slack_webhook' }, { label: 'Microsoft Teams workflow', value: 'teams_workflow' }, { label: 'Email', value: 'email' }, { label: 'Signed webhook', value: 'webhook' }]} onChange={(value: string) => setChannel((current) => ({ ...current, type: value as ChannelType }))} />
      <Input name="recommendation-channel-name" label="Channel name" value={channel.name} onChange={(value: string) => setChannel((current) => ({ ...current, name: value }))} />
      {channel.type === 'email'
        ? <Input name="recommendation-channel-recipients" label="Email recipients" description="Comma-separated operational recipients." value={channel.recipients} onChange={(value: string) => setChannel((current) => ({ ...current, recipients: value }))} />
        : <Input name="recommendation-channel-endpoint" label={channel.id ? 'Replacement HTTPS endpoint (optional)' : 'HTTPS endpoint'} value={channel.endpoint} onChange={(value: string) => setChannel((current) => ({ ...current, endpoint: value }))} />}
      {channel.type === 'webhook' ? <Input name="recommendation-channel-signing-secret" label="Signing secret (optional)" description="Leave blank on creation to generate a secret." value={channel.signingSecret} onChange={(value: string) => setChannel((current) => ({ ...current, signingSecret: value }))} /> : null}
      <Toggle name="recommendation-channel-enabled" label="Enable channel" checked={channel.enabled} onChange={(checked: boolean) => setChannel((current) => ({ ...current, enabled: checked }))} />
      <Flex direction="row" gap="small"><Button disabled={!canManage || working !== null} onClick={() => void saveChannel()}>{working === 'channel' ? 'Saving…' : channel.id ? 'Save channel' : 'Create channel'}</Button>{channel.id ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void deleteChannel()}>{working === 'delete' ? 'Deleting…' : 'Delete channel'}</Button> : null}<Button variant="secondary" disabled={working !== null} onClick={() => setChannel(EMPTY_CHANNEL)}>Clear</Button></Flex>
    </Flex>

    <Divider />
    <Flex direction="column" gap="small">
      <Heading>Quiet-hours calendars</Heading>
      {calendars.map((item) => <Card key={item.id}><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><Text variant="microcopy">{item.timezone} · Monday–Friday schedule</Text><Button variant="secondary" disabled={!canManage || working !== null} onClick={() => setCalendar(editCalendar(item))}>Edit calendar</Button></Flex></Card>)}
      <Input name="recommendation-calendar-name" label="Calendar name" value={calendar.name} onChange={(value: string) => setCalendar((current) => ({ ...current, name: value }))} />
      <Input name="recommendation-calendar-timezone" label="IANA timezone" value={calendar.timezone} onChange={(value: string) => setCalendar((current) => ({ ...current, timezone: value }))} />
      <Flex direction="row" gap="small"><Input name="recommendation-calendar-start" label="Weekday start (HH:MM)" value={calendar.start} onChange={(value: string) => setCalendar((current) => ({ ...current, start: value }))} /><Input name="recommendation-calendar-end" label="Weekday end (HH:MM)" value={calendar.end} onChange={(value: string) => setCalendar((current) => ({ ...current, end: value }))} /></Flex>
      <Input name="recommendation-calendar-holidays" label="Holiday dates" description="Comma-separated YYYY-MM-DD dates." value={calendar.holidays} onChange={(value: string) => setCalendar((current) => ({ ...current, holidays: value }))} />
      <Flex direction="row" gap="small"><Button disabled={!canManage || working !== null} onClick={() => void saveCalendar()}>{working === 'calendar' ? 'Saving…' : calendar.id ? 'Save calendar' : 'Create calendar'}</Button><Button variant="secondary" disabled={working !== null} onClick={() => setCalendar(EMPTY_CALENDAR)}>Clear</Button></Flex>
    </Flex>

    <Divider />
    <Flex direction="column" gap="small">
      <Heading>Explicit notification routes</Heading>
      {routes.length === 0 ? <Text>No notification route is configured.</Text> : routes.map((item) => <Card key={item.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center"><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><StatusTag variant={item.enabled ? 'success' : 'default'}>{item.enabled ? 'Enabled' : 'Disabled'}</StatusTag></Flex><Text variant="microcopy">{item.eventTypes.join(', ') || 'No event opt-in'} · {item.channelIds.length} channel(s) · cooldown {item.suppressionWindowMinutes} min</Text><Button variant="secondary" disabled={!canManage || working !== null} onClick={() => setRoute(editRoute(item))}>Edit route</Button></Flex></Card>)}
      <Input name="recommendation-route-name" label="Route name" value={route.name} onChange={(value: string) => setRoute((current) => ({ ...current, name: value }))} />
      <MultiSelect name="recommendation-route-events" label="Explicit recommendation events" options={EVENT_OPTIONS} value={route.eventTypes} onChange={(value: string[]) => setRoute((current) => ({ ...current, eventTypes: value }))} />
      <MultiSelect name="recommendation-route-channels" label="Enabled channels" options={channelOptions} value={route.channelIds} onChange={(value: string[]) => setRoute((current) => ({ ...current, channelIds: value }))} />
      <Flex direction="row" gap="small" wrap="wrap"><Select name="recommendation-route-severity" label="Minimum severity" value={route.minimumSeverity} options={[{ label: 'Info', value: 'info' }, { label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]} onChange={(value: string) => setRoute((current) => ({ ...current, minimumSeverity: value as Severity }))} /><Select name="recommendation-route-calendar" label="Quiet-hours calendar" value={route.quietHoursCalendarId} options={calendarOptions} onChange={(value: string) => setRoute((current) => ({ ...current, quietHoursCalendarId: value }))} /><NumberInput name="recommendation-route-cooldown" label="Suppression window minutes" value={route.suppressionWindowMinutes} min={0} max={10080} onChange={(value: number) => setRoute((current) => ({ ...current, suppressionWindowMinutes: value }))} /></Flex>
      <Flex direction="row" gap="small" wrap="wrap"><Input name="recommendation-route-pipelines" label="Pipeline IDs" value={route.pipelineIds} onChange={(value: string) => setRoute((current) => ({ ...current, pipelineIds: value }))} /><Input name="recommendation-route-teams" label="Team IDs" value={route.teamIds} onChange={(value: string) => setRoute((current) => ({ ...current, teamIds: value }))} /><Input name="recommendation-route-owners" label="Owner IDs" value={route.ownerIds} onChange={(value: string) => setRoute((current) => ({ ...current, ownerIds: value }))} /><Input name="recommendation-route-regions" label="Region codes" value={route.regionCodes} onChange={(value: string) => setRoute((current) => ({ ...current, regionCodes: value }))} /></Flex>
      <Toggle name="recommendation-route-enabled" label="Enable route" checked={route.enabled} onChange={(checked: boolean) => setRoute((current) => ({ ...current, enabled: checked }))} />
      <Flex direction="row" gap="small"><Button disabled={!canManage || working !== null || route.channelIds.length === 0 || route.eventTypes.length === 0} onClick={() => void saveRoute()}>{working === 'route' ? 'Saving…' : route.id ? 'Save route' : 'Create route'}</Button>{route.id ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void saveRoute({ enabled: !route.enabled })}>{route.enabled ? 'Disable route' : 'Enable route'}</Button> : null}<Button variant="secondary" disabled={working !== null} onClick={() => setRoute(EMPTY_ROUTE)}>Clear</Button></Flex>
    </Flex>

    <Alert title="Configuration safety" variant="info">Routes must explicitly opt into recommendation events. Channel endpoints and webhook secrets are encrypted, quiet hours are rechecked at delivery, and no route authorizes a HubSpot CRM mutation.</Alert>
  </Flex>;
}
