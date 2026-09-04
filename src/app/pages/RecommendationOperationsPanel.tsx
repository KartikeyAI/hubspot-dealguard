import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Link,
  LoadingSpinner,
  Select,
  StatusTag,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const EXPORT_WINDOWS = [30, 90, 180] as const;
type ExportWindow = typeof EXPORT_WINDOWS[number];
type FollowupKind = 'owner_reminder' | 'manager_review';
type Severity = 'warning' | 'critical';
type BatchStatus = 'previewed' | 'confirming' | 'queued' | 'delivering' | 'completed' | 'partially_failed' | 'failed' | 'expired';

type Candidate = {
  id: string;
  dealId: string;
  recommendationCode: string;
  label: string;
  action: string;
  dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  status: 'presented' | 'accepted';
  overdue: boolean;
  rationale: string;
};

type RoutingMatch = {
  routeIds: string[];
  channelIds: string[];
  routes: Array<{
    id: string;
    name: string;
    channelNames: string[];
  }>;
  ready: boolean;
};

type Batch = {
  id: string;
  kind: FollowupKind;
  severity: Severity;
  managerNote: string;
  authorizationMode?: 'human_confirmation' | 'configured_policy';
  automationPolicyId?: string | null;
  status: BatchStatus;
  requestedCount: number;
  eligibleCount: number;
  deliveryReadyCount: number;
  confirmedCount: number;
  deliveredCount: number;
  failedCount: number;
  deliveryReady: boolean;
  confirmationRequired: boolean;
  previewExpiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    recommendationId: string;
    dealId: string;
    label: string;
    action: string;
    recommendationStatus: string;
    priority: Candidate['priority'];
    dueAt: string | null;
    overdue: boolean;
    status: 'previewed' | 'unroutable' | 'queued' | 'delivering' | 'delivered' | 'partially_failed' | 'failed' | 'skipped';
    eligible: boolean;
    deliveryReady: boolean;
    ineligibilityReason: string | null;
    routing: RoutingMatch;
  }>;
};

type CandidateResponse = {
  candidates: Candidate[];
  batches: Batch[];
  routing: {
    explicitEventType: string;
    eligibleRoutes: Array<{
      id: string;
      name: string;
      channelCount: number;
      quietHoursConfigured: boolean;
      suppressionWindowMinutes: number;
      currentlyInQuietHours: boolean;
    }>;
    ready: boolean;
  };
  permissions: {
    canView: boolean;
    canBulkFollowup: boolean;
    canManageRouting: boolean;
    canExport: boolean;
  };
};

type SecureDownload = { url: string; expiresAt: string };

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'No deadline recorded';
}

function priorityVariant(priority: Candidate['priority']): 'danger' | 'warning' | 'default' {
  return priority === 'high' ? 'danger' : priority === 'medium' ? 'warning' : 'default';
}

function batchVariant(status: BatchStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'completed') return 'success';
  if (status === 'previewed' || status === 'confirming' || status === 'queued' || status === 'delivering') return 'warning';
  if (status === 'failed' || status === 'partially_failed' || status === 'expired') return 'danger';
  return 'default';
}

function ownerLabel(value: Candidate['owner']): string {
  return value === 'manager' ? 'Sales manager' : 'Deal owner';
}

export function RecommendationOperationsPanel({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<CandidateResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [kind, setKind] = useState<FollowupKind>('owner_reminder');
  const [severity, setSeverity] = useState<Severity>('warning');
  const [managerNote, setManagerNote] = useState('Please review the selected recommendation and record a dated next action.');
  const [preview, setPreview] = useState<Batch | null>(null);
  const [exportWindow, setExportWindow] = useState<ExportWindow>(90);
  const [download, setDownload] = useState<SecureDownload | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [working, setWorking] = useState<'refresh' | 'preview' | 'confirm' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setWorking('refresh');
    else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-followups/candidates`, {
        method: 'GET',
        timeout: 15_000,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'Recommendation operations could not be loaded.'));
      const next = payload as CandidateResponse;
      setData(next);
      const available = new Set(next.candidates.map((candidate) => candidate.id));
      setSelectedIds((current) => current.filter((id) => available.has(id)));
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'Recommendation operations could not be loaded.'));
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

  const toggle = useCallback((id: string) => {
    setPreview(null);
    setSelectedIds((current) => current.includes(id)
      ? current.filter((value) => value !== id)
      : current.length >= 100
        ? current
        : [...current, id]);
  }, []);

  const previewFollowup = useCallback(async () => {
    if (selectedIds.length === 0) {
      setError('Select at least one recommendation before creating a follow-up preview.');
      return;
    }
    if (managerNote.trim().length < 10) {
      setError('Add at least 10 characters of deterministic guidance before previewing delivery.');
      return;
    }
    setWorking('preview');
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-followups/preview`, {
        method: 'POST',
        timeout: 15_000,
        body: { recommendationIds: selectedIds, kind, severity, managerNote },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The route preview could not be created.'));
      setPreview(payload as Batch);
      setNotice('Preview created. Review route, channel, quiet-hour, and eligibility evidence before confirming.');
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The route preview could not be created.'));
    } finally {
      setWorking(null);
    }
  }, [kind, managerNote, selectedIds, severity]);

  const confirmFollowup = useCallback(async () => {
    if (!preview) return;
    setWorking('confirm');
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-followups/${encodeURIComponent(preview.id)}/confirm`, {
        method: 'POST',
        timeout: 15_000,
        body: {},
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The follow-up could not be confirmed.'));
      setPreview(null);
      setSelectedIds([]);
      setNotice('Follow-up confirmed and queued through the explicitly opted-in DealGuard routes. No CRM or recommendation lifecycle state was changed.');
      await load(false);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The follow-up could not be confirmed.'));
    } finally {
      setWorking(null);
    }
  }, [load, preview]);

  const createExport = useCallback(async () => {
    setWorking('export');
    setError(null);
    setNotice(null);
    setDownload(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/downloads`, {
        method: 'POST',
        timeout: 15_000,
        body: {
          kind: 'recommendation_evidence',
          format: 'csv',
          params: { days: exportWindow },
        },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(safeProductError(payload?.error?.message, 'The recommendation evidence export could not be created.'));
      setDownload(payload as SecureDownload);
      setNotice('One-time evidence export created. The secure link expires shortly and can be consumed once.');
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The recommendation evidence export could not be created.'));
    } finally {
      setWorking(null);
    }
  }, [exportWindow]);

  if (!enabled) return <Card><Flex direction="column" gap="small"><Heading>Recommendation operations</Heading><Text>Enterprise workspaces can coordinate human-confirmed follow-ups through governed notification routes and create one-time evidence exports.</Text></Flex></Card>;
  if (loading) return <LoadingSpinner label="Loading recommendation operations" />;

  const candidates = data?.candidates ?? [];
  const batches = data?.batches ?? [];
  const routes = data?.routing.eligibleRoutes ?? [];
  const canFollowup = Boolean(data?.permissions.canBulkFollowup);
  const routeReady = Boolean(data?.routing.ready);
  const canExport = Boolean(data?.permissions.canExport);

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small"><Heading>Recommendation operations</Heading><Text>Select current recommendations, preview the exact route and channel delivery plan, confirm it, and retain bounded delivery evidence.</Text></Flex>
      <Button variant="secondary" disabled={working !== null} onClick={() => void load(true)}>{working === 'refresh' ? 'Refreshing…' : 'Refresh operations'}</Button>
    </Flex>

    {error ? <Alert title="Recommendation operation failed" variant="danger">{error}</Alert> : null}
    {notice ? <Alert title="Recommendation operation updated" variant="success">{notice}</Alert> : null}

    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small"><Heading>Human-confirmed follow-up</Heading><StatusTag variant={canFollowup && routeReady ? 'success' : 'default'}>{canFollowup && routeReady ? 'Ready' : 'Configuration required'}</StatusTag></Flex>
      <Text>Manual follow-up requires remediation.bulk, an active recommendation, an explicit route opt-in for {data?.routing.explicitEventType ?? 'recommendation.followup.requested'}, and a second confirmation step.</Text>
      {!canFollowup ? <Alert title="Bulk follow-up is restricted" variant="info">The remediation.bulk permission is required. Recommendation history and deterministic actions remain available.</Alert> : null}
      {canFollowup && !routeReady ? <Alert title="No currently deliverable route" variant="warning">Enable a notification route that explicitly includes the manual follow-up event, has at least one configured channel, and is outside quiet hours.</Alert> : null}

      {routes.length > 0 ? <Flex direction="column" gap="extra-small">
        <Text variant="microcopy">Eligible manual routes</Text>
        {routes.map((route) => <Text key={route.id} variant="microcopy">• {route.name} · {route.channelCount} channel(s) · cooldown floor {route.suppressionWindowMinutes} min · {route.currentlyInQuietHours ? 'quiet hours active' : route.quietHoursConfigured ? 'quiet hours configured' : 'no quiet-hours calendar'}</Text>)}
      </Flex> : null}

      {candidates.length === 0 ? <Alert title="No active recommendation" variant="success">No current presented or accepted recommendation is available in your assigned scope.</Alert> : <Flex direction="column" gap="small">
        <Text variant="microcopy">{selectedIds.length} selected · {candidates.length} available · maximum 100 per preview</Text>
        {candidates.slice(0, 20).map((candidate) => {
          const selected = selectedIds.includes(candidate.id);
          return <Card key={candidate.id}><Flex direction="column" gap="extra-small">
            <Flex direction="row" justify="between" align="center" gap="small">
              <Flex direction="column" gap="extra-small"><Text variant="microcopy">DEAL {candidate.dealId} · {candidate.dimension.replaceAll('_', ' ')}</Text><Text format={{ fontWeight: 'bold' }}>{candidate.label}</Text></Flex>
              <Flex direction="row" gap="extra-small" wrap="wrap"><StatusTag variant={candidate.status === 'accepted' ? 'warning' : 'default'}>{candidate.status}</StatusTag><StatusTag variant={priorityVariant(candidate.priority)}>{candidate.priority}</StatusTag>{candidate.overdue ? <StatusTag variant="danger">Overdue</StatusTag> : null}</Flex>
            </Flex>
            <Text>{candidate.action}</Text>
            <Text variant="microcopy">Owner: {ownerLabel(candidate.owner)} · Due: {formatDate(candidate.dueAt)}</Text>
            <Button variant={selected ? 'primary' : 'secondary'} disabled={!canFollowup || !routeReady || working !== null} onClick={() => toggle(candidate.id)}>{selected ? 'Selected' : 'Select for follow-up'}</Button>
          </Flex></Card>;
        })}
        {candidates.length > 20 ? <Text variant="microcopy">Showing the first 20 ranked candidates. Narrow the manager scope or complete higher-priority work to reduce the queue.</Text> : null}
      </Flex>}

      {canFollowup ? <Flex direction="column" gap="small">
        <Flex direction="row" gap="small" wrap="wrap">
          <Select name="recommendation-followup-kind" label="Follow-up type" value={kind} options={[{ label: 'Owner reminder', value: 'owner_reminder' }, { label: 'Manager review', value: 'manager_review' }]} onChange={(value) => { setKind(String(value) as FollowupKind); setPreview(null); }} />
          <Select name="recommendation-followup-severity" label="Severity" value={severity} options={[{ label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]} onChange={(value) => { setSeverity(String(value) as Severity); setPreview(null); }} />
        </Flex>
        <TextArea name="recommendation-followup-note" label="Deterministic guidance" description="10–2,000 characters. Do not include contact details or communication content." rows={3} maxLength={2000} resize="vertical" value={managerNote} onChange={(value: string) => { setManagerNote(value); setPreview(null); }} />
        <Button disabled={working !== null || selectedIds.length === 0 || !routeReady} onClick={() => void previewFollowup()}>{working === 'preview' ? 'Creating preview…' : 'Preview routes and channels'}</Button>
      </Flex> : null}

      {preview ? <Card><Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small"><Heading>Confirmation preview</Heading><StatusTag variant={preview.deliveryReady ? 'warning' : 'danger'}>{preview.deliveryReady ? 'Confirmation required' : 'Not delivery ready'}</StatusTag></Flex>
        <Text>{preview.requestedCount} requested · {preview.eligibleCount} eligible · {preview.deliveryReadyCount} route-ready · expires {formatDate(preview.previewExpiresAt)}</Text>
        {preview.items.map((item) => <Flex key={item.recommendationId} direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{item.label}</Text><Text variant="microcopy">Deal {item.dealId} · {item.status} · {item.routing.routes.map((route) => `${route.name}: ${route.channelNames.join(', ')}`).join(' · ') || item.ineligibilityReason || 'No route'}</Text></Flex>)}
        <Alert title="Human confirmation required" variant="info">Confirming queues deterministic notifications through the displayed routes. It does not accept, complete, dismiss, supersede, or otherwise change a recommendation or HubSpot record.</Alert>
        <Flex direction="row" gap="small"><Button disabled={working !== null || !preview.deliveryReady} onClick={() => void confirmFollowup()}>{working === 'confirm' ? 'Confirming…' : 'Confirm and queue delivery'}</Button><Button variant="secondary" disabled={working !== null} onClick={() => setPreview(null)}>Cancel preview</Button></Flex>
      </Flex></Card> : null}
    </Flex>

    {batches.length > 0 ? <Flex direction="column" gap="small"><Divider /><Heading>Recent follow-up batches</Heading>{batches.slice(0, 5).map((batch) => <Card key={batch.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{batch.kind.replaceAll('_', ' ')}</Text><StatusTag variant={batchVariant(batch.status)}>{batch.status.replaceAll('_', ' ')}</StatusTag></Flex><Text>{batch.deliveredCount} delivered · {batch.failedCount} failed · {batch.deliveryReadyCount} route-ready</Text><Text variant="microcopy">{batch.authorizationMode === 'configured_policy' ? 'Configured policy' : 'Human confirmed'} · created {formatDate(batch.createdAt)}</Text></Flex></Card>)}</Flex> : null}

    <Divider />
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center"><Heading>Recommendation evidence export</Heading><StatusTag variant={canExport ? 'success' : 'default'}>{canExport ? 'Permitted' : 'Restricted'}</StatusTag></Flex>
      <Text>Create a scoped, one-time CSV of bounded recommendation lifecycle and observed-outcome evidence.</Text>
      <Flex direction="row" gap="small" wrap="wrap">{EXPORT_WINDOWS.map((days) => <Button key={days} variant={exportWindow === days ? 'primary' : 'secondary'} disabled={!canExport || working !== null} onClick={() => { setExportWindow(days); setDownload(null); }}>{days} days</Button>)}</Flex>
      <Button disabled={!canExport || working !== null} onClick={() => void createExport()}>{working === 'export' ? 'Creating export…' : 'Create one-time CSV export'}</Button>
      {download ? <Alert title="One-time export ready" variant="success">Expires {formatDate(download.expiresAt)}. <Link href={{ url: download.url, external: true }}>Download CSV</Link></Alert> : null}
    </Flex>

    <Alert title="Governed operations boundary" variant="info">Manual follow-ups require explicit preview and confirmation. Configured SLA policies are managed separately and constitute durable notification authorization. Both paths use explicit route opt-in, honour quiet hours, retain bounded delivery evidence, and never mutate CRM data.</Alert>
  </Flex>;
}
