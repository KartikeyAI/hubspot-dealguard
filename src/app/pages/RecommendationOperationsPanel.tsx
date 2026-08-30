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
  StatusTag,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const EXPORT_WINDOWS = [30, 90, 180] as const;
type ExportWindow = typeof EXPORT_WINDOWS[number];
type BatchStatus = 'previewed' | 'queued' | 'sending' | 'completed' | 'partially_failed' | 'failed' | 'expired';

type FollowUpCandidate = {
  id: string;
  dealId: string;
  label: string;
  action: string;
  dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  status: 'presented' | 'accepted';
  overdue: boolean;
  rationale: string;
  presentedAt: string;
};

type FollowUpBatch = {
  id: string;
  channel: 'email';
  routeName: string;
  status: BatchStatus;
  requestedCount: number;
  eligibleCount: number;
  skippedCount: number;
  recipientCount: number;
  deliverySuccessCount: number;
  deliveryFailureCount: number;
  createdAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  expiresAt: string;
};

type CandidateResponse = {
  candidates: FollowUpCandidate[];
  batches: FollowUpBatch[];
  permissions: {
    canView: boolean;
    canManage: boolean;
    canRouteNotifications: boolean;
    canExport: boolean;
  };
};

type PreviewResponse = {
  batchId: string;
  confirmationToken: string;
  expiresAt: string;
  route: { channel: 'email'; name: string; recipientCount: number };
  summary: { requested: number; eligible: number; skipped: number };
  items: Array<{
    recommendationId: string;
    dealId: string | null;
    dealName: string | null;
    label: string | null;
    priority: 'high' | 'medium' | 'low' | null;
    status: string;
    itemStatus: 'eligible' | 'skipped';
    skipReason: string | null;
  }>;
};

type ExportResponse = {
  exportId: string;
  rowCount: number;
  expiresAt: string;
  downloadUrl: string;
  contentSha256: string;
};

function statusVariant(status: BatchStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'completed') return 'success';
  if (status === 'queued' || status === 'sending' || status === 'previewed') return 'warning';
  if (status === 'failed' || status === 'partially_failed' || status === 'expired') return 'danger';
  return 'default';
}

function priorityVariant(priority: FollowUpCandidate['priority']): 'danger' | 'warning' | 'default' {
  if (priority === 'high') return 'danger';
  if (priority === 'medium') return 'warning';
  return 'default';
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'No deadline recorded';
}

function emails(value: string): string[] {
  return [...new Set(value
    .split(/[\n,;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function ownerLabel(owner: FollowUpCandidate['owner']): string {
  return owner === 'manager' ? 'Sales manager' : 'Deal owner';
}

export function RecommendationOperationsPanel({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<CandidateResponse | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [recipientText, setRecipientText] = useState('');
  const [managerNote, setManagerNote] = useState('');
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [exportWindow, setExportWindow] = useState<ExportWindow>(90);
  const [exportResult, setExportResult] = useState<ExportResponse | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [working, setWorking] = useState<'preview' | 'confirm' | 'export' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-follow-ups/candidates`, {
        method: 'GET',
        timeout: 15_000,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(payload?.error?.message, 'Recommendation operations could not be loaded.'));
      }
      const next = payload as CandidateResponse;
      setData(next);
      const availableIds = new Set(next.candidates.map((candidate) => candidate.id));
      setSelectedIds((current) => current.filter((id) => availableIds.has(id)));
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'Recommendation operations could not be loaded. Please try again.',
      ));
    } finally {
      setLoading(false);
      setRefreshing(false);
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
      : current.length >= 25
        ? current
        : [...current, id]);
  }, []);

  const previewFollowUp = useCallback(async () => {
    const recipients = emails(recipientText);
    if (selectedIds.length === 0) {
      setError('Select at least one recommendation before creating a follow-up preview.');
      return;
    }
    if (recipients.length === 0) {
      setError('Provide at least one recipient before creating a follow-up preview.');
      return;
    }
    setWorking('preview');
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-follow-ups/preview`, {
        method: 'POST',
        timeout: 15_000,
        body: {
          recommendationIds: selectedIds,
          recipients,
          note: managerNote,
          routeName: 'Manager recommendation follow-up',
        },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(payload?.error?.message, 'The follow-up preview could not be created.'));
      }
      setPreview(payload as PreviewResponse);
      setNotice('Preview created. Review the eligible work and recipient count before confirming delivery.');
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'The follow-up preview could not be created.',
      ));
    } finally {
      setWorking(null);
    }
  }, [managerNote, recipientText, selectedIds]);

  const confirmFollowUp = useCallback(async () => {
    if (!preview) return;
    setWorking('confirm');
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-follow-ups/${preview.batchId}/confirm`, {
        method: 'POST',
        timeout: 15_000,
        body: { confirmationToken: preview.confirmationToken },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(payload?.error?.message, 'The follow-up could not be confirmed.'));
      }
      setPreview(null);
      setSelectedIds([]);
      setManagerNote('');
      setNotice('Follow-up confirmed and queued for governed delivery. No recommendation or CRM record was changed.');
      await load(true);
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'The follow-up could not be confirmed.',
      ));
    } finally {
      setWorking(null);
    }
  }, [load, preview]);

  const createExport = useCallback(async () => {
    setWorking('export');
    setError(null);
    setNotice(null);
    setExportResult(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-outcomes/export`, {
        method: 'POST',
        timeout: 15_000,
        body: { days: exportWindow },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(payload?.error?.message, 'The evidence export could not be created.'));
      }
      setExportResult(payload as ExportResponse);
      setNotice('One-time evidence export created. The secure link expires shortly.');
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'The evidence export could not be created.',
      ));
    } finally {
      setWorking(null);
    }
  }, [exportWindow]);

  if (!enabled) {
    return <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center">
          <Heading>Recommendation operations</Heading>
          <StatusTag variant="default">Enterprise</StatusTag>
        </Flex>
        <Text>Coordinate human-confirmed recommendation follow-ups and produce short-lived, auditable evidence exports.</Text>
      </Flex>
    </Card>;
  }

  if (loading) return <LoadingSpinner label="Loading recommendation operations" />;
  const candidates = data?.candidates ?? [];
  const batches = data?.batches ?? [];
  const canRoute = Boolean(data?.permissions.canManage && data.permissions.canRouteNotifications);
  const canExport = Boolean(data?.permissions.canExport);

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Recommendation operations</Heading>
        <Text>Coordinate selected follow-ups with explicit preview and confirmation, then export bounded lifecycle evidence for review.</Text>
      </Flex>
      <Button variant="secondary" disabled={refreshing || working !== null} onClick={() => void load(true)}>
        {refreshing ? 'Refreshing…' : 'Refresh operations'}
      </Button>
    </Flex>

    {error && <Alert title="Recommendation operation failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Recommendation operation updated" variant="success">{notice}</Alert>}

    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small">
        <Flex direction="column" gap="extra-small">
          <Heading>Manager follow-up</Heading>
          <Text>Select up to 25 presented or accepted recommendations. Delivery cannot begin until a manager previews and confirms the exact batch.</Text>
        </Flex>
        <StatusTag variant={canRoute ? 'success' : 'default'}>{canRoute ? 'Routing permitted' : 'Read only'}</StatusTag>
      </Flex>

      {!canRoute && <Alert title="Follow-up routing is restricted" variant="info">
        Bulk follow-up requires both remediation.manage and alert.manage. Recommendation history and deterministic actions remain available without these permissions.
      </Alert>}

      {candidates.length === 0
        ? <Alert title="No active recommendations to route" variant="success">
            No presented or accepted recommendation is currently available in your assigned scope.
          </Alert>
        : <Flex direction="column" gap="small">
            <Text variant="microcopy">{selectedIds.length} selected · maximum 25 per confirmed batch</Text>
            {candidates.slice(0, 12).map((candidate) => {
              const selected = selectedIds.includes(candidate.id);
              return <Card key={candidate.id}>
                <Flex direction="column" gap="extra-small">
                  <Flex direction="row" justify="between" align="center" gap="small">
                    <Flex direction="column" gap="extra-small">
                      <Text variant="microcopy">DEAL {candidate.dealId} · {candidate.dimension.replaceAll('_', ' ')}</Text>
                      <Text format={{ fontWeight: 'bold' }}>{candidate.label}</Text>
                    </Flex>
                    <Flex direction="row" gap="extra-small" wrap="wrap">
                      <StatusTag variant={candidate.status === 'accepted' ? 'warning' : 'default'}>{candidate.status}</StatusTag>
                      <StatusTag variant={priorityVariant(candidate.priority)}>{candidate.priority}</StatusTag>
                      {candidate.overdue && <StatusTag variant="danger">Overdue</StatusTag>}
                    </Flex>
                  </Flex>
                  <Text>{candidate.action}</Text>
                  <Text variant="microcopy">Owner: {ownerLabel(candidate.owner)} · Due: {formatDate(candidate.dueAt)}</Text>
                  <Button
                    variant={selected ? 'primary' : 'secondary'}
                    disabled={!canRoute || working !== null}
                    onClick={() => toggle(candidate.id)}
                  >{selected ? 'Selected' : 'Select for follow-up'}</Button>
                </Flex>
              </Card>;
            })}
          </Flex>}

      {canRoute && <Flex direction="column" gap="small">
        <TextArea
          name="recommendation-follow-up-recipients"
          label="Recipients"
          description="One email address per line, or separate addresses with commas. Maximum 10. Values are encrypted before the preview is stored."
          placeholder="manager@example.com"
          rows={3}
          maxLength={2500}
          resize="vertical"
          value={recipientText}
          onChange={(value: string) => {
            setRecipientText(value);
            setPreview(null);
          }}
        />
        <TextArea
          name="recommendation-follow-up-note"
          label="Manager note"
          description="Optional, maximum 500 characters. Do not include sensitive customer or communication content."
          placeholder="Please review these actions before the next pipeline meeting."
          rows={3}
          maxLength={500}
          resize="vertical"
          value={managerNote}
          onChange={(value: string) => {
            setManagerNote(value);
            setPreview(null);
          }}
        />
        <Button disabled={working !== null || selectedIds.length === 0} onClick={() => void previewFollowUp()}>
          {working === 'preview' ? 'Creating preview…' : 'Preview follow-up'}
        </Button>
      </Flex>}

      {preview && <Card>
        <Flex direction="column" gap="small">
          <Flex direction="row" justify="between" align="center" gap="small">
            <Heading>Confirmation preview</Heading>
            <StatusTag variant="warning">Expires {formatDate(preview.expiresAt)}</StatusTag>
          </Flex>
          <Text>{preview.summary.eligible} eligible · {preview.summary.skipped} skipped · {preview.route.recipientCount} recipients</Text>
          {preview.items.filter((item) => item.itemStatus === 'skipped').map((item) => <Text key={item.recommendationId} variant="microcopy">
            • Skipped {item.label ?? item.recommendationId}: {item.skipReason ?? 'not eligible'}
          </Text>)}
          <Alert title="Human confirmation required" variant="info">
            Confirming queues one email per recipient. It does not accept, complete, dismiss, supersede, or otherwise change any recommendation or CRM record.
          </Alert>
          <Flex direction="row" gap="small">
            <Button disabled={working !== null} onClick={() => void confirmFollowUp()}>
              {working === 'confirm' ? 'Confirming…' : 'Confirm and queue delivery'}
            </Button>
            <Button variant="secondary" disabled={working !== null} onClick={() => setPreview(null)}>Cancel preview</Button>
          </Flex>
        </Flex>
      </Card>}
    </Flex>

    {batches.length > 0 && <Flex direction="column" gap="small">
      <Divider />
      <Heading>Your recent follow-up batches</Heading>
      {batches.slice(0, 5).map((batch) => <Card key={batch.id}>
        <Flex direction="column" gap="extra-small">
          <Flex direction="row" justify="between" align="center" gap="small">
            <Text format={{ fontWeight: 'bold' }}>{batch.routeName}</Text>
            <StatusTag variant={statusVariant(batch.status)}>{batch.status.replaceAll('_', ' ')}</StatusTag>
          </Flex>
          <Text>{batch.eligibleCount} eligible · {batch.skippedCount} skipped · {batch.recipientCount} recipients</Text>
          <Text variant="microcopy">Delivered: {batch.deliverySuccessCount} · failed: {batch.deliveryFailureCount} · created {formatDate(batch.createdAt)}</Text>
        </Flex>
      </Card>)}
    </Flex>}

    <Divider />
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center" gap="small">
        <Flex direction="column" gap="extra-small">
          <Heading>Recommendation evidence export</Heading>
          <Text>Create a one-time CSV snapshot of bounded recommendation lifecycle and observed-outcome evidence in your assigned scope.</Text>
        </Flex>
        <StatusTag variant={canExport ? 'success' : 'default'}>{canExport ? 'Export permitted' : 'Restricted'}</StatusTag>
      </Flex>
      <Flex direction="row" gap="small" wrap="wrap">
        {EXPORT_WINDOWS.map((days) => <Button
          key={days}
          variant={exportWindow === days ? 'primary' : 'secondary'}
          disabled={working !== null || !canExport}
          onClick={() => {
            setExportWindow(days);
            setExportResult(null);
          }}
        >{days} days</Button>)}
      </Flex>
      <Button disabled={working !== null || !canExport} onClick={() => void createExport()}>
        {working === 'export' ? 'Creating export…' : 'Create secure CSV export'}
      </Button>
      {!canExport && <Text variant="microcopy">The analytics.export permission is required. The export never includes contact or communication content.</Text>}
      {exportResult && <Alert title="One-time export ready" variant="success">
        {exportResult.rowCount} rows · expires {formatDate(exportResult.expiresAt)}. The content checksum begins {exportResult.contentSha256.slice(0, 12)}.
        {' '}<Link href={{ url: exportResult.downloadUrl, external: true }}>Download CSV</Link>
      </Alert>}
    </Flex>

    <Alert title="Governed operations boundary" variant="info">
      Follow-ups require explicit preview and confirmation, retain only encrypted recipients and hashed delivery evidence, and never change CRM data. Exports are one-time, short-lived snapshots. Outcome evidence remains observational and non-causal.
    </Alert>
  </Flex>;
}
