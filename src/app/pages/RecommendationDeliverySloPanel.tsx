import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Input,
  LoadingSpinner,
  NumberInput,
  Select,
  StatusTag,
  Text,
  Toggle,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const SLO_PATH = '/enterprise/recommendation-delivery-slos';
const REQUIRED_EVENTS = [
  'recommendation.delivery.slo.breached',
  'recommendation.delivery.slo.reminder',
  'recommendation.delivery.slo.recovered',
];

type Metric =
  | 'delivery_success_percent'
  | 'failure_count'
  | 'route_unavailable_count'
  | 'escalation_sla_breach_count'
  | 'p95_completion_minutes';
type TargetType = 'portal' | 'route' | 'channel' | 'routing_policy';
type SloStatus = 'insufficient_data' | 'meeting' | 'breaching' | 'breached' | 'recovering';
type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
type NotificationStatus = 'queued' | 'delivering' | 'deferred' | 'delivered' | 'partially_failed' | 'failed';

type SloState = {
  status: SloStatus;
  consecutiveBreaches: number;
  consecutiveRecoveries: number;
  currentValue: number | null;
  sampleCount: number;
  evidenceStartAt: string | null;
  evidenceEndAt: string | null;
  evidenceTruncated: boolean;
  lastReason: string | null;
  evaluatedAt: string;
};

type SloPolicy = {
  id: string;
  name: string;
  metric: Metric;
  targetType: TargetType;
  targetId: string | null;
  targetLabel: string;
  comparison: 'minimum' | 'maximum';
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
  lastEvaluatedAt: string | null;
  lastValue: number | null;
  lastSampleCount: number;
  lastStatus: SloStatus | null;
  lastError: string | null;
  state: SloState | null;
};

type Incident = {
  id: string;
  sloPolicyId: string;
  policyName: string;
  status: IncidentStatus;
  severity: 'warning' | 'critical';
  metric: Metric;
  targetLabel: string;
  comparison: 'minimum' | 'maximum';
  thresholdValue: number;
  worstValue: number | null;
  lastValue: number | null;
  lastSampleCount: number;
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  alertCount: number;
  lastNotificationStatus: NotificationStatus | null;
};

type Notification = {
  id: string;
  incidentId: string;
  policyName: string;
  routeName: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  status: NotificationStatus;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
  deliverySummary: Array<{ channelName: string; channelType: string; status: 'delivered' | 'failed'; error: string | null }>;
};

type RouteOption = {
  id: string;
  name: string;
  eventTypes: string[];
  enabled: boolean;
  globalScope: boolean;
  quietHoursConfigured: boolean;
  suppressionWindowMinutes: number;
  channels: Array<{ id: string; name: string; type: string }>;
};

type TargetOption = { id: string; label: string; type: Exclude<TargetType, 'portal'> };

type SloResponse = {
  generatedAt: string;
  policies: SloPolicy[];
  incidents: Incident[];
  notifications: Notification[];
  routes: RouteOption[];
  targets: TargetOption[];
  permissions: { canView: boolean; canManage: boolean; portalWideAccess: boolean };
  limits: { maxPolicies: number; evaluationCadenceMinutes: number; evidenceRetentionDays: number };
};

type FormState = {
  id: string | null;
  name: string;
  metric: Metric;
  targetType: TargetType;
  targetId: string;
  thresholdValue: number;
  windowMinutes: number;
  minimumSamples: number;
  breachEvaluations: number;
  recoveryEvaluations: number;
  severity: 'warning' | 'critical';
  notificationRouteId: string;
  alertCooldownMinutes: number;
  maxAlertsPerIncident: number;
  notifyRecovery: boolean;
  enabled: boolean;
};

const EMPTY_FORM: FormState = {
  id: null,
  name: 'Recommendation delivery reliability',
  metric: 'delivery_success_percent',
  targetType: 'portal',
  targetId: '',
  thresholdValue: 95,
  windowMinutes: 1440,
  minimumSamples: 10,
  breachEvaluations: 2,
  recoveryEvaluations: 2,
  severity: 'warning',
  notificationRouteId: '',
  alertCooldownMinutes: 1440,
  maxAlertsPerIncident: 3,
  notifyRecovery: true,
  enabled: false,
};

function metricLabel(metric: Metric): string {
  if (metric === 'delivery_success_percent') return 'Delivery success percentage';
  if (metric === 'failure_count') return 'Failed delivery count';
  if (metric === 'route_unavailable_count') return 'Route unavailable count';
  if (metric === 'escalation_sla_breach_count') return 'Escalation SLA breach count';
  return '95th-percentile completion time';
}

function targetCompatible(metric: Metric, target: TargetType): boolean {
  if (metric === 'route_unavailable_count') return target === 'portal' || target === 'route';
  if (metric === 'escalation_sla_breach_count' || metric === 'p95_completion_minutes') {
    return target === 'portal' || target === 'routing_policy';
  }
  return true;
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function formatMetric(metric: Metric, value: number | null): string {
  if (value === null) return 'Unavailable';
  if (metric === 'delivery_success_percent') return `${value}%`;
  if (metric === 'p95_completion_minutes') return value < 60 ? `${value} min` : `${Math.round(value / 6) / 10} hr`;
  return String(value);
}

function statusVariant(status: SloStatus | IncidentStatus | NotificationStatus | null): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'meeting' || status === 'resolved' || status === 'delivered') return 'success';
  if (status === 'breaching' || status === 'recovering' || status === 'acknowledged' || status === 'queued' || status === 'delivering' || status === 'deferred') return 'warning';
  if (status === 'breached' || status === 'open' || status === 'failed' || status === 'partially_failed') return 'danger';
  return 'default';
}

function formFromPolicy(policy: SloPolicy): FormState {
  return {
    id: policy.id,
    name: policy.name,
    metric: policy.metric,
    targetType: policy.targetType,
    targetId: policy.targetId ?? '',
    thresholdValue: policy.thresholdValue,
    windowMinutes: policy.windowMinutes,
    minimumSamples: policy.minimumSamples,
    breachEvaluations: policy.breachEvaluations,
    recoveryEvaluations: policy.recoveryEvaluations,
    severity: policy.severity,
    notificationRouteId: policy.notificationRouteId,
    alertCooldownMinutes: policy.alertCooldownMinutes,
    maxAlertsPerIncident: policy.maxAlertsPerIncident,
    notifyRecovery: policy.notifyRecovery,
    enabled: policy.enabled,
  };
}

export function RecommendationDeliverySloPanel({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<SloResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<'refresh' | 'save' | 'delete' | 'evaluate' | 'acknowledge' | 'route' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const request = useCallback(async (
    path: string,
    options: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> } = {},
  ) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      timeout: 15_000,
      ...(options.body ? { body: options.body } : {}),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'Recommendation delivery SLO request failed.'));
    return payload;
  }, []);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setWorking('refresh');
    else setLoading(true);
    setError(null);
    try {
      setData(await request(SLO_PATH) as SloResponse);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Recommendation delivery SLOs could not be loaded.'));
    } finally {
      setLoading(false);
      setWorking(null);
    }
  }, [enabled, request]);

  const routeOptions = useMemo(() => (data?.routes ?? [])
    .filter((route) => route.enabled && route.globalScope && route.channels.length > 0)
    .map((route) => ({ label: `${route.name} · ${route.channels.length} channel(s)`, value: route.id })), [data]);
  const targetOptions = useMemo(() => [
    { label: 'Entire portal', value: '' },
    ...(data?.targets ?? []).filter((target) => target.type === form.targetType).map((target) => ({ label: target.label, value: target.id })),
  ], [data, form.targetType]);
  const canManage = Boolean(data?.permissions.canManage);
  const selectedRoute = data?.routes.find((route) => route.id === form.notificationRouteId) ?? null;
  const routeReady = Boolean(selectedRoute
    && selectedRoute.enabled
    && selectedRoute.globalScope
    && selectedRoute.channels.length > 0
    && REQUIRED_EVENTS.every((event) => selectedRoute.eventTypes.includes(event)));

  const save = useCallback(async () => {
    if (!form.notificationRouteId) {
      setError('Select a portal-wide notification route before saving the SLO.');
      return;
    }
    setWorking('save');
    setError(null);
    setNotice(null);
    try {
      const path = form.id ? `${SLO_PATH}/${encodeURIComponent(form.id)}` : SLO_PATH;
      const result = await request(path, {
        method: form.id ? 'PUT' : 'POST',
        body: {
          name: form.name,
          metric: form.metric,
          targetType: form.targetType,
          targetId: form.targetType === 'portal' ? null : form.targetId,
          thresholdValue: form.thresholdValue,
          windowMinutes: form.windowMinutes,
          minimumSamples: form.minimumSamples,
          breachEvaluations: form.breachEvaluations,
          recoveryEvaluations: form.recoveryEvaluations,
          severity: form.severity,
          notificationRouteId: form.notificationRouteId,
          alertCooldownMinutes: form.alertCooldownMinutes,
          maxAlertsPerIncident: form.maxAlertsPerIncident,
          notifyRecovery: form.notifyRecovery,
          enabled: form.enabled,
        },
      }) as SloPolicy;
      setForm(formFromPolicy(result));
      setNotice(result.enabled ? 'Delivery SLO saved and enabled.' : 'Delivery SLO saved as disabled.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The delivery SLO could not be saved.'));
    } finally {
      setWorking(null);
    }
  }, [form, load, request]);

  const remove = useCallback(async () => {
    if (!form.id) return;
    setWorking('delete');
    setError(null);
    try {
      await request(`${SLO_PATH}/${encodeURIComponent(form.id)}`, { method: 'DELETE' });
      setForm(EMPTY_FORM);
      setNotice('Delivery SLO deleted.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The delivery SLO could not be deleted.'));
    } finally {
      setWorking(null);
    }
  }, [form.id, load, request]);

  const evaluate = useCallback(async () => {
    setWorking('evaluate');
    setError(null);
    try {
      await request(`${SLO_PATH}/evaluate`, { method: 'POST', body: {} });
      setNotice('Delivery SLO evaluation was queued. Refresh after the maintenance cycle processes current evidence.');
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Delivery SLO evaluation could not be queued.'));
    } finally {
      setWorking(null);
    }
  }, [request]);

  const enableRouteEvents = useCallback(async (routeId: string) => {
    setWorking('route');
    setError(null);
    try {
      await request(`${SLO_PATH}/routes/${encodeURIComponent(routeId)}/enable-events`, { method: 'POST', body: {} });
      setNotice('The route now explicitly subscribes to delivery SLO breach, reminder and recovery events.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'SLO route events could not be enabled.'));
    } finally {
      setWorking(null);
    }
  }, [load, request]);

  const acknowledge = useCallback(async (incidentId: string) => {
    setWorking('acknowledge');
    setError(null);
    try {
      await request(`${SLO_PATH}/incidents/${encodeURIComponent(incidentId)}/acknowledge`, { method: 'POST', body: {} });
      setNotice('Delivery SLO incident acknowledged. Automatic recovery evaluation remains active.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The delivery SLO incident could not be acknowledged.'));
    } finally {
      setWorking(null);
    }
  }, [load, request]);

  if (!enabled) return <Card><Flex direction="column" gap="small"><Heading>Delivery SLOs & operational alerts</Heading><Text>Enterprise workspaces can enforce notification-delivery objectives and route governed breach and recovery alerts.</Text></Flex></Card>;
  if (loading) return <LoadingSpinner label="Loading recommendation delivery SLOs" />;
  if (!data) return <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Flex direction="column" gap="extra-small"><Heading>Delivery SLOs & operational alerts</Heading><Text>Configure delivery objectives, breach persistence, recovery evidence and governed route-based alerts.</Text></Flex><StatusTag variant="default">On demand</StatusTag></Flex>{error ? <Alert title="Delivery SLOs unavailable" variant="danger">{error}</Alert> : null}<Alert title="Operational evidence only" variant="info">Delivery SLOs measure notification transport and scheduler evidence. They do not infer deal outcomes, revenue impact or causal effect, and they never modify HubSpot CRM.</Alert><Button onClick={() => void load(false)}>Load delivery SLOs</Button></Flex></Card>;

  const openIncidents = data.incidents.filter((incident) => incident.status !== 'resolved');
  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="small">
      <Flex direction="column" gap="extra-small"><Heading>Delivery SLOs & operational alerts</Heading><Text>Enforce configurable delivery objectives with persistent breach evidence, governed notification routes and automatic recovery.</Text></Flex>
      <Flex direction="row" gap="small"><Button variant="secondary" disabled={working !== null} onClick={() => void load(true)}>{working === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button><Button disabled={!canManage || working !== null} onClick={() => void evaluate()}>{working === 'evaluate' ? 'Queueing…' : 'Evaluate now'}</Button></Flex>
    </Flex>
    {error ? <Alert title="Delivery SLO operation failed" variant="danger">{error}</Alert> : null}
    {notice ? <Alert title="Delivery SLO updated" variant="success">{notice}</Alert> : null}
    {!canManage ? <Alert title="Delivery SLOs are read only" variant="info">Portal-wide reliability.manage and alert.manage permissions are required to configure objectives and routes.</Alert> : null}

    <Flex direction="column" gap="small">
      <Heading>Active incidents</Heading>
      {openIncidents.length === 0 ? <Alert title="No open delivery SLO incident" variant="success">No configured delivery objective currently has a confirmed open breach.</Alert> : openIncidents.map((incident) => <Card key={incident.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center"><Flex direction="column" gap="extra-small"><Text variant="microcopy">{incident.targetLabel} · {metricLabel(incident.metric)}</Text><Text format={{ fontWeight: 'bold' }}>{incident.policyName}</Text></Flex><Flex direction="row" gap="extra-small"><StatusTag variant={incident.severity === 'critical' ? 'danger' : 'warning'}>{incident.severity}</StatusTag><StatusTag variant={statusVariant(incident.status)}>{incident.status}</StatusTag></Flex></Flex><Text>Observed {formatMetric(incident.metric, incident.lastValue)} from {incident.lastSampleCount} sample(s); objective {incident.comparison === 'minimum' ? '≥' : '≤'} {formatMetric(incident.metric, incident.thresholdValue)}.</Text><Text variant="microcopy">Opened {formatDate(incident.openedAt)} · last observed {formatDate(incident.lastObservedAt)} · alerts {incident.alertCount} · notification {incident.lastNotificationStatus ?? 'not queued'}</Text>{incident.status === 'open' ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void acknowledge(incident.id)}>Acknowledge incident</Button> : null}</Flex></Card>)}
    </Flex>

    <Divider />
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center"><Heading>Configured objectives</Heading><Text variant="microcopy">{data.policies.length}/{data.limits.maxPolicies} policies</Text></Flex>
      {data.policies.length === 0 ? <Text>No delivery SLO is configured.</Text> : data.policies.map((policy) => <Card key={policy.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center"><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{policy.name}</Text><Text variant="microcopy">{policy.targetLabel} · {metricLabel(policy.metric)}</Text></Flex><Flex direction="row" gap="extra-small"><StatusTag variant={policy.enabled ? 'success' : 'default'}>{policy.enabled ? 'Enabled' : 'Disabled'}</StatusTag><StatusTag variant={statusVariant(policy.state?.status ?? policy.lastStatus)}>{policy.state?.status ?? policy.lastStatus ?? 'not evaluated'}</StatusTag></Flex></Flex><Text>Objective: {policy.comparison === 'minimum' ? 'at least' : 'at most'} {formatMetric(policy.metric, policy.thresholdValue)} across {policy.windowMinutes} minutes with {policy.minimumSamples} minimum samples.</Text><Text variant="microcopy">Current: {formatMetric(policy.metric, policy.state?.currentValue ?? policy.lastValue)} · samples {policy.state?.sampleCount ?? policy.lastSampleCount} · route {policy.notificationRouteName}</Text>{policy.lastError ? <Alert title="Policy evaluation warning" variant="warning">{policy.lastError}</Alert> : null}<Button variant="secondary" disabled={!canManage || working !== null} onClick={() => setForm(formFromPolicy(policy))}>Edit objective</Button></Flex></Card>)}
    </Flex>

    <Divider />
    <Flex direction="column" gap="small">
      <Heading>{form.id ? 'Edit delivery SLO' : 'Create delivery SLO'}</Heading>
      <Input name="delivery-slo-name" label="Objective name" value={form.name} onChange={(value) => setForm((current) => ({ ...current, name: String(value) }))} />
      <Select name="delivery-slo-metric" label="Metric" value={form.metric} options={[
        { label: 'Delivery success percentage', value: 'delivery_success_percent' },
        { label: 'Failed delivery count', value: 'failure_count' },
        { label: 'Route unavailable count', value: 'route_unavailable_count' },
        { label: 'Escalation SLA breach count', value: 'escalation_sla_breach_count' },
        { label: '95th-percentile completion time', value: 'p95_completion_minutes' },
      ]} onChange={(value) => {
        const next = String(value) as Metric;
        setForm((current) => ({ ...current, metric: next, targetType: targetCompatible(next, current.targetType) ? current.targetType : 'portal', targetId: targetCompatible(next, current.targetType) ? current.targetId : '', thresholdValue: next === 'delivery_success_percent' ? 95 : next === 'p95_completion_minutes' ? 60 : 0 }));
      }} />
      <Select name="delivery-slo-target-type" label="Target" value={form.targetType} options={[
        { label: 'Entire portal', value: 'portal' },
        { label: 'Notification route', value: 'route' },
        { label: 'Notification channel', value: 'channel' },
        { label: 'Recommendation routing policy', value: 'routing_policy' },
      ].filter((option) => targetCompatible(form.metric, option.value as TargetType))} onChange={(value) => setForm((current) => ({ ...current, targetType: String(value) as TargetType, targetId: '' }))} />
      {form.targetType !== 'portal' ? <Select name="delivery-slo-target-id" label="Target record" value={form.targetId} options={targetOptions.slice(1)} onChange={(value) => setForm((current) => ({ ...current, targetId: String(value) }))} /> : null}
      <Flex direction="row" gap="small" wrap="wrap">
        <NumberInput name="delivery-slo-threshold" label="Threshold" value={form.thresholdValue} min={0} max={100000} onChange={(value: number) => setForm((current) => ({ ...current, thresholdValue: value }))} />
        <NumberInput name="delivery-slo-window" label="Window (minutes)" value={form.windowMinutes} min={60} max={43200} onChange={(value: number) => setForm((current) => ({ ...current, windowMinutes: value }))} />
        <NumberInput name="delivery-slo-samples" label="Minimum samples" value={form.minimumSamples} min={1} max={10000} onChange={(value: number) => setForm((current) => ({ ...current, minimumSamples: value }))} />
      </Flex>
      <Flex direction="row" gap="small" wrap="wrap">
        <NumberInput name="delivery-slo-breach-evaluations" label="Evaluations before breach" value={form.breachEvaluations} min={1} max={10} onChange={(value: number) => setForm((current) => ({ ...current, breachEvaluations: value }))} />
        <NumberInput name="delivery-slo-recovery-evaluations" label="Evaluations before recovery" value={form.recoveryEvaluations} min={1} max={10} onChange={(value: number) => setForm((current) => ({ ...current, recoveryEvaluations: value }))} />
        <NumberInput name="delivery-slo-cooldown" label="Alert cooldown (minutes)" value={form.alertCooldownMinutes} min={15} max={43200} onChange={(value: number) => setForm((current) => ({ ...current, alertCooldownMinutes: value }))} />
        <NumberInput name="delivery-slo-max-alerts" label="Maximum alerts per incident" value={form.maxAlertsPerIncident} min={1} max={10} onChange={(value: number) => setForm((current) => ({ ...current, maxAlertsPerIncident: value }))} />
      </Flex>
      <Select name="delivery-slo-severity" label="Alert severity" value={form.severity} options={[{ label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]} onChange={(value) => setForm((current) => ({ ...current, severity: String(value) as 'warning' | 'critical' }))} />
      <Select name="delivery-slo-route" label="Portal-wide notification route" value={form.notificationRouteId} options={routeOptions} onChange={(value) => setForm((current) => ({ ...current, notificationRouteId: String(value) }))} />
      {selectedRoute && !routeReady ? <Alert title="Explicit route opt-in required" variant="warning">The selected route must be portal-wide and explicitly subscribe to breach, reminder and recovery events. <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void enableRouteEvents(selectedRoute.id)}>Enable SLO events on this route</Button></Alert> : null}
      <Toggle name="delivery-slo-recovery" label="Notify when the objective recovers" checked={form.notifyRecovery} onChange={(checked: boolean) => setForm((current) => ({ ...current, notifyRecovery: checked }))} />
      <Toggle name="delivery-slo-enabled" label="Enable automated evaluation and alerts" checked={form.enabled} onChange={(checked: boolean) => setForm((current) => ({ ...current, enabled: checked }))} />
      <Flex direction="row" gap="small"><Button disabled={!canManage || working !== null || !routeReady || (form.targetType !== 'portal' && !form.targetId)} onClick={() => void save()}>{working === 'save' ? 'Saving…' : 'Save delivery SLO'}</Button>{form.id ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void remove()}>{working === 'delete' ? 'Deleting…' : 'Delete'}</Button> : null}<Button variant="secondary" disabled={working !== null} onClick={() => setForm(EMPTY_FORM)}>Reset form</Button></Flex>
    </Flex>

    {data.notifications.length > 0 ? <><Divider /><Flex direction="column" gap="small"><Heading>Recent governed SLO notifications</Heading>{data.notifications.slice(0, 10).map((notification) => <Card key={notification.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center"><Text format={{ fontWeight: 'bold' }}>{notification.policyName}</Text><StatusTag variant={statusVariant(notification.status)}>{notification.status.replaceAll('_', ' ')}</StatusTag></Flex><Text variant="microcopy">{notification.eventType} · route {notification.routeName} · {formatDate(notification.createdAt)}</Text>{notification.lastError ? <Text>{notification.lastError}</Text> : null}</Flex></Card>)}</Flex></> : null}

    <Alert title="Enforcement boundary" variant="info">An incident opens only after the configured number of consecutive sufficient-evidence breaches. Insufficient or truncated evidence cannot open an incident. Alerts use explicit reusable routes, respect quiet hours, and never mutate CRM or recommendation lifecycle state.</Alert>
  </Flex>;
}
