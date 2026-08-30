import React, { useCallback, useEffect, useState } from 'react';
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
  TextArea,
  Toggle,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const POLICY_PATH = '/enterprise/recommendation-routing-policies';
type Trigger = 'due_soon' | 'overdue';
type StatusScope = 'presented' | 'accepted' | 'both';
type Priority = 'low' | 'medium' | 'high';
type Severity = 'warning' | 'critical';
type ChannelType = 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';

type Scope = { pipelineIds: string[]; teamIds: string[]; ownerIds: string[]; regionCodes: string[] };
type Policy = {
  id: string;
  name: string;
  trigger: Trigger;
  statusScope: StatusScope;
  minimumPriority: Priority;
  thresholdMinutes: number;
  cooldownMinutes: number;
  maxNotifications: number;
  severity: Severity;
  routeId: string;
  escalationRouteId: string | null;
  escalationAfterMinutes: number | null;
  managerNote: string;
  scope: Scope;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt: string | null;
  lastMatchCount: number;
  lastQueueCount: number;
  lastError: string | null;
  dispatchSummary: { active: number; queued: number; delivered: number; failed: number; escalated: number };
};

type RouteOption = {
  id: string;
  name: string;
  eventTypes: string[];
  channelIds: string[];
  suppressionWindowMinutes: number;
  enabled: boolean;
  quietHoursConfigured: boolean;
  channels: Array<{ id: string; name: string; type: ChannelType }>;
};

type PolicyResponse = {
  policies: Policy[];
  routes: RouteOption[];
  permissions: { canView: boolean; canManage: boolean; canRun: boolean };
};

type Preview = {
  evaluatedAt: string;
  matchedCount: number;
  deliveryReadyCount: number;
  escalationReadyCount: number;
  items: Array<{
    recommendationId: string;
    dealId: string;
    label: string;
    status: string;
    priority: Priority;
    dueAt: string | null;
    deliveryReady: boolean;
    stage: 'initial' | 'repeat' | 'escalation' | null;
    reason: string;
    routeNames: string[];
    channelNames: string[];
  }>;
};

type FormState = {
  id: string | null;
  name: string;
  trigger: Trigger;
  statusScope: StatusScope;
  minimumPriority: Priority;
  thresholdMinutes: number;
  cooldownMinutes: number;
  maxNotifications: number;
  severity: Severity;
  routeId: string;
  escalationRouteId: string;
  escalationAfterMinutes: number;
  managerNote: string;
  scope: Scope;
  enabled: boolean;
};

const EMPTY_SCOPE: Scope = { pipelineIds: [], teamIds: [], ownerIds: [], regionCodes: [] };
const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  trigger: 'overdue',
  statusScope: 'accepted',
  minimumPriority: 'high',
  thresholdMinutes: 60,
  cooldownMinutes: 1440,
  maxNotifications: 3,
  severity: 'warning',
  routeId: '',
  escalationRouteId: '',
  escalationAfterMinutes: 1440,
  managerNote: 'Please review the recommendation and record a dated next action.',
  scope: EMPTY_SCOPE,
  enabled: false,
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function channelName(type: ChannelType): string {
  if (type === 'slack_webhook') return 'Slack';
  if (type === 'teams_workflow') return 'Microsoft Teams';
  if (type === 'email') return 'Email';
  return 'Signed webhook';
}

function eventFor(trigger: Trigger): string {
  return trigger === 'due_soon' ? 'recommendation.policy.due_soon' : 'recommendation.policy.overdue';
}

function editForm(policy: Policy): FormState {
  return {
    id: policy.id,
    name: policy.name,
    trigger: policy.trigger,
    statusScope: policy.statusScope,
    minimumPriority: policy.minimumPriority,
    thresholdMinutes: policy.thresholdMinutes,
    cooldownMinutes: policy.cooldownMinutes,
    maxNotifications: policy.maxNotifications,
    severity: policy.severity,
    routeId: policy.routeId,
    escalationRouteId: policy.escalationRouteId ?? '',
    escalationAfterMinutes: policy.escalationAfterMinutes ?? 1440,
    managerNote: policy.managerNote,
    scope: policy.scope,
    enabled: policy.enabled,
  };
}

function policyVariant(policy: Policy): 'success' | 'warning' | 'danger' | 'default' {
  if (!policy.enabled) return 'default';
  if (policy.lastError || policy.dispatchSummary.failed > 0) return 'danger';
  if (policy.lastQueueCount > 0 || policy.dispatchSummary.queued > 0) return 'warning';
  return 'success';
}

export function RecommendationRoutingPoliciesPanel({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [working, setWorking] = useState<'save' | 'preview' | 'delete' | 'evaluate' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setWorking('refresh');
    else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${POLICY_PATH}`, { method: 'GET', timeout: 15_000 });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'Routing policies could not be loaded.'));
      setData(payload as PolicyResponse);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Routing policies could not be loaded.'));
    } finally {
      setLoading(false);
      setWorking(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    void load(false);
  }, [enabled, load]);

  const requestBody = useCallback((override?: Partial<FormState>) => {
    const value = { ...form, ...override };
    return {
      ...(value.id ? { id: value.id } : {}),
      name: value.name,
      trigger: value.trigger,
      statusScope: value.statusScope,
      minimumPriority: value.minimumPriority,
      thresholdMinutes: value.thresholdMinutes,
      cooldownMinutes: value.cooldownMinutes,
      maxNotifications: value.maxNotifications,
      severity: value.severity,
      routeId: value.routeId,
      escalationRouteId: value.escalationRouteId || null,
      escalationAfterMinutes: value.escalationRouteId ? value.escalationAfterMinutes : null,
      managerNote: value.managerNote,
      scope: value.scope,
      enabled: value.enabled,
    };
  }, [form]);

  const previewPolicy = useCallback(async () => {
    setWorking('preview');
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${POLICY_PATH}/preview`, {
        method: 'POST',
        timeout: 15_000,
        body: requestBody(),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The policy preview could not be generated.'));
      setPreview(payload as Preview);
      setNotice('Preview completed without sending a notification or changing CRM data.');
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The policy preview could not be generated.'));
    } finally {
      setWorking(null);
    }
  }, [requestBody]);

  const savePolicy = useCallback(async (override?: Partial<FormState>) => {
    const next = { ...form, ...override };
    setWorking('save');
    setError(null);
    setNotice(null);
    try {
      const path = next.id ? `${POLICY_PATH}/${encodeURIComponent(next.id)}` : POLICY_PATH;
      const response = await hubspot.fetch(`${API_BASE}${path}`, {
        method: next.id ? 'PUT' : 'POST',
        timeout: 15_000,
        body: requestBody(override),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The routing policy could not be saved.'));
      setForm(editForm(payload as Policy));
      setPreview(null);
      setNotice(next.enabled ? 'Routing policy saved and enabled.' : 'Routing policy saved as disabled.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The routing policy could not be saved.'));
    } finally {
      setWorking(null);
    }
  }, [form, load, requestBody]);

  const deletePolicy = useCallback(async () => {
    if (!form.id) return;
    setWorking('delete');
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${POLICY_PATH}/${encodeURIComponent(form.id)}`, {
        method: 'DELETE',
        timeout: 15_000,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The routing policy could not be deleted.'));
      setForm(EMPTY_FORM);
      setPreview(null);
      setNotice('Routing policy deleted. Historical delivery evidence remains available.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The routing policy could not be deleted.'));
    } finally {
      setWorking(null);
    }
  }, [form.id, load]);

  const evaluateNow = useCallback(async () => {
    setWorking('evaluate');
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${POLICY_PATH}/evaluate`, {
        method: 'POST',
        timeout: 15_000,
        body: {},
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'Policy evaluation could not be completed.'));
      setNotice(`Evaluation completed: ${Number(payload.queuedRecommendations ?? 0)} recommendation notification(s) queued across ${Number(payload.queuedBatches ?? 0)} batch(es).`);
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Policy evaluation could not be completed.'));
    } finally {
      setWorking(null);
    }
  }, [load]);

  if (!enabled) return <Card><Flex direction="column" gap="small"><Heading>Recommendation routing & SLAs</Heading><Text>Enterprise workspaces can configure reusable Slack, Microsoft Teams, email, and webhook routes for due and overdue recommendations.</Text></Flex></Card>;
  if (loading) return <LoadingSpinner label="Loading recommendation routing policies" />;

  const policies = data?.policies ?? [];
  const routes = data?.routes ?? [];
  const canManage = Boolean(data?.permissions.canManage);
  const initialEvent = eventFor(form.trigger);
  const initialRoutes = routes.filter((route) => route.enabled && route.eventTypes.includes(initialEvent));
  const escalationRoutes = routes.filter((route) => route.enabled && route.eventTypes.includes('recommendation.policy.escalated'));
  const initialOptions = [{ label: 'Select an opted-in route', value: '' }, ...initialRoutes.map((route) => ({
    label: `${route.name} · ${route.channels.map((channel) => channelName(channel.type)).join(', ') || 'no enabled channel'}`,
    value: route.id,
  }))];
  const escalationOptions = [{ label: 'No manager escalation', value: '' }, ...escalationRoutes.map((route) => ({
    label: `${route.name} · ${route.channels.map((channel) => channelName(channel.type)).join(', ') || 'no enabled channel'}`,
    value: route.id,
  }))];

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small"><Heading>Recommendation routing & SLAs</Heading><Text>Use existing DealGuard routes, channels, quiet hours, suppression windows, and data scopes to govern deterministic due and overdue notifications.</Text></Flex>
      <Flex direction="row" gap="small"><Button variant="secondary" disabled={working !== null} onClick={() => void load(true)}>{working === 'refresh' ? 'Refreshing…' : 'Refresh policies'}</Button><Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void evaluateNow()}>{working === 'evaluate' ? 'Evaluating…' : 'Evaluate now'}</Button></Flex>
    </Flex>

    {error ? <Alert title="Routing policy action failed" variant="danger">{error}</Alert> : null}
    {notice ? <Alert title="Routing policy updated" variant="success">{notice}</Alert> : null}
    {!canManage ? <Alert title="Routing is read only" variant="info">The alert.manage permission is required to change or evaluate routing policies.</Alert> : null}

    {policies.length === 0 ? <Alert title="No routing policy configured" variant="info">Create a disabled policy, preview current matches, and enable it only after its route and SLA are correct.</Alert> : <Flex direction="column" gap="small">
      <Heading>Configured policies</Heading>
      {policies.map((policy) => <Card key={policy.id}><Flex direction="column" gap="extra-small">
        <Flex direction="row" justify="between" align="center" gap="small"><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{policy.name}</Text><Text variant="microcopy">{policy.trigger.replaceAll('_', ' ')} · {policy.statusScope} · minimum {policy.minimumPriority}</Text></Flex><StatusTag variant={policyVariant(policy)}>{policy.enabled ? 'Enabled' : 'Disabled'}</StatusTag></Flex>
        <Text>{policy.managerNote}</Text>
        <Text variant="microcopy">Threshold {policy.thresholdMinutes} min · cooldown {policy.cooldownMinutes} min · maximum {policy.maxNotifications} notifications</Text>
        <Text variant="microcopy">Last evaluation {formatDate(policy.lastEvaluatedAt)} · matched {policy.lastMatchCount} · queued {policy.lastQueueCount} · escalated {policy.dispatchSummary.escalated}</Text>
        {policy.lastError ? <Text variant="microcopy">Last limitation: {policy.lastError}</Text> : null}
        <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => { setForm(editForm(policy)); setPreview(null); setNotice(null); setError(null); }}>Edit policy</Button>
      </Flex></Card>)}
    </Flex>}

    <Divider />
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small"><Heading>{form.id ? 'Edit routing policy' : 'Create routing policy'}</Heading>{form.id ? <Button variant="secondary" disabled={working !== null} onClick={() => { setForm(EMPTY_FORM); setPreview(null); }}>New policy</Button> : null}</Flex>
      <Input name="recommendation-policy-name" label="Policy name" value={form.name} onChange={(value: string) => { setForm((current) => ({ ...current, name: value })); setPreview(null); }} />
      <Flex direction="row" gap="small" wrap="wrap">
        <Select name="recommendation-policy-trigger" label="Trigger" value={form.trigger} options={[{ label: 'Due soon', value: 'due_soon' }, { label: 'Overdue', value: 'overdue' }]} onChange={(value: string) => { setForm((current) => ({ ...current, trigger: value as Trigger, routeId: '' })); setPreview(null); }} />
        <Select name="recommendation-policy-lifecycle" label="Recommendation lifecycle" value={form.statusScope} options={[{ label: 'Accepted only', value: 'accepted' }, { label: 'Presented only', value: 'presented' }, { label: 'Presented and accepted', value: 'both' }]} onChange={(value: string) => { setForm((current) => ({ ...current, statusScope: value as StatusScope })); setPreview(null); }} />
        <Select name="recommendation-policy-priority" label="Minimum priority" value={form.minimumPriority} options={[{ label: 'High', value: 'high' }, { label: 'Medium', value: 'medium' }, { label: 'Low', value: 'low' }]} onChange={(value: string) => { setForm((current) => ({ ...current, minimumPriority: value as Priority })); setPreview(null); }} />
        <Select name="recommendation-policy-severity" label="Notification severity" value={form.severity} options={[{ label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]} onChange={(value: string) => { setForm((current) => ({ ...current, severity: value as Severity })); setPreview(null); }} />
      </Flex>
      <Flex direction="row" gap="small" wrap="wrap">
        <NumberInput name="recommendation-policy-threshold" label={form.trigger === 'due_soon' ? 'Notify within minutes of due date' : 'Grace minutes after due date'} value={form.thresholdMinutes} min={0} max={43200} onChange={(value: number) => { setForm((current) => ({ ...current, thresholdMinutes: value })); setPreview(null); }} />
        <NumberInput name="recommendation-policy-cooldown" label="Cooldown minutes" value={form.cooldownMinutes} min={15} max={43200} onChange={(value: number) => { setForm((current) => ({ ...current, cooldownMinutes: value })); setPreview(null); }} />
        <NumberInput name="recommendation-policy-maximum" label="Maximum notifications" value={form.maxNotifications} min={1} max={10} onChange={(value: number) => { setForm((current) => ({ ...current, maxNotifications: value })); setPreview(null); }} />
      </Flex>
      <Select name="recommendation-policy-route" label={`Initial route · must opt into ${initialEvent}`} value={form.routeId} options={initialOptions} onChange={(value: string) => { setForm((current) => ({ ...current, routeId: value })); setPreview(null); }} />
      {initialRoutes.length === 0 ? <Alert title="No opted-in initial route" variant="warning">Enable a notification route whose event types explicitly include {initialEvent}. It can reuse Slack, Microsoft Teams, email, or a signed webhook channel.</Alert> : null}
      <Select name="recommendation-policy-escalation-route" label="Manager escalation route" value={form.escalationRouteId} options={escalationOptions} onChange={(value: string) => { setForm((current) => ({ ...current, escalationRouteId: value })); setPreview(null); }} />
      {form.escalationRouteId ? <NumberInput name="recommendation-policy-escalation-after" label="Escalate after minutes" value={form.escalationAfterMinutes} min={15} max={43200} onChange={(value: number) => { setForm((current) => ({ ...current, escalationAfterMinutes: value })); setPreview(null); }} /> : null}
      <TextArea name="recommendation-policy-note" label="Deterministic notification guidance" description="10–2,000 characters. Do not include contact details or communication content." value={form.managerNote} rows={3} maxLength={2000} resize="vertical" onChange={(value: string) => { setForm((current) => ({ ...current, managerNote: value })); setPreview(null); }} />
      <Text variant="microcopy">Enabling this policy is durable authorization for notifications matching these conditions. It never authorizes a CRM or recommendation lifecycle mutation.</Text>
      <Toggle name="recommendation-policy-enabled" label="Enable policy" checked={form.enabled} onChange={(checked: boolean) => setForm((current) => ({ ...current, enabled: checked }))} />
      <Flex direction="row" gap="small" wrap="wrap">
        <Button disabled={!canManage || working !== null || !form.routeId} onClick={() => void previewPolicy()}>{working === 'preview' ? 'Previewing…' : 'Preview current matches'}</Button>
        <Button disabled={!canManage || working !== null || !form.routeId} onClick={() => void savePolicy()}>{working === 'save' ? 'Saving…' : form.id ? 'Save policy' : 'Create policy'}</Button>
        {form.id ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void savePolicy({ enabled: !form.enabled })}>{form.enabled ? 'Disable policy' : 'Enable policy'}</Button> : null}
        {form.id ? <Button variant="secondary" disabled={!canManage || working !== null} onClick={() => void deletePolicy()}>{working === 'delete' ? 'Deleting…' : 'Delete policy'}</Button> : null}
      </Flex>
    </Flex>

    {preview ? <Card><Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small"><Heading>Policy preview</Heading><StatusTag variant={preview.deliveryReadyCount > 0 ? 'warning' : 'default'}>{preview.deliveryReadyCount} delivery ready</StatusTag></Flex>
      <Text>{preview.matchedCount} matching recommendation(s) · {preview.escalationReadyCount} escalation-ready · evaluated {formatDate(preview.evaluatedAt)}</Text>
      {preview.items.map((item) => <Flex key={item.recommendationId} direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{item.label}</Text><Text variant="microcopy">Deal {item.dealId} · {item.status} · {item.priority} · due {formatDate(item.dueAt)} · {item.stage ?? 'suppressed'}</Text><Text variant="microcopy">{item.reason}{item.channelNames.length ? ` Channels: ${item.channelNames.join(', ')}.` : ''}</Text></Flex>)}
      <Alert title="Preview sends nothing" variant="info">Saving the policy as enabled authorizes later deterministic notifications. Previewing alone does not send, transition a recommendation, or modify a HubSpot record.</Alert>
    </Flex></Card> : null}

    <Alert title="Routing governance boundary" variant="info">Policies require explicit route event opt-in, honour route data scope and quiet hours, apply the larger of route suppression and policy cooldown, and allow one configured manager escalation. They never edit CRM data.</Alert>
  </Flex>;
}
