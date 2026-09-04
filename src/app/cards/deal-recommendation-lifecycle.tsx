import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Flex,
  Heading,
  LoadingSpinner,
  StatusTag,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { API_BASE, formatDate } from './deal-intelligence-shared';

type RecommendationStatus = 'presented' | 'accepted' | 'completed' | 'dismissed' | 'expired' | 'superseded';
type RecommendationTransition = 'accept' | 'complete' | 'dismiss';
type ObservedProgress = 'improved' | 'mixed' | 'unchanged' | 'worsened' | 'insufficient_evidence';

type RecommendationOutcome = {
  evaluationStatus: 'pending' | 'observed' | 'insufficient_evidence';
  observedProgress: ObservedProgress | null;
  observationAssessmentAt: string | null;
  readinessDelta: number | null;
  attentionDelta: number | null;
  explanation: string | null;
  causalAttribution: false;
};

type Recommendation = {
  id: string;
  dealId: string;
  recommendationCode: string;
  label: string;
  action: string;
  dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  evidenceCodes: string[];
  status: RecommendationStatus;
  terminalReason: string | null;
  presentedAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  supersededAt: string | null;
  dismissalReason: string | null;
  overdue: boolean;
  current: boolean;
  outcome: RecommendationOutcome | null;
};

type RecommendationList = {
  recommendations: Recommendation[];
  semantics: {
    observationalOnly: true;
    causalAttribution: false;
    completionDoesNotProveImpact: true;
    missingEvidenceDoesNotMeanFailure: true;
  };
};

type AccessContext = {
  role?: string;
  permissions?: string[];
  entitled?: boolean;
};

function permissionMatches(granted: string[], required: string): boolean {
  return granted.includes('*')
    || granted.includes(required)
    || granted.some((item) => item.endsWith('.*') && required.startsWith(item.slice(0, -1)));
}

function statusVariant(status: RecommendationStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'completed') return 'success';
  if (status === 'accepted') return 'warning';
  if (status === 'expired') return 'danger';
  return 'default';
}

function priorityVariant(priority: Recommendation['priority']): 'danger' | 'warning' | 'default' {
  if (priority === 'high') return 'danger';
  if (priority === 'medium') return 'warning';
  return 'default';
}

function outcomeVariant(progress: ObservedProgress): 'success' | 'warning' | 'danger' | 'info' {
  if (progress === 'improved') return 'success';
  if (progress === 'mixed') return 'warning';
  if (progress === 'worsened') return 'danger';
  return 'info';
}

function statusLabel(status: RecommendationStatus): string {
  return status.replaceAll('_', ' ');
}

function outcomeLabel(progress: ObservedProgress): string {
  return progress.replaceAll('_', ' ');
}

function ownerLabel(owner: Recommendation['owner']): string {
  return owner === 'manager' ? 'Sales manager' : 'Deal owner';
}

function signed(value: number | null): string {
  if (value === null) return 'not comparable';
  return `${value > 0 ? '+' : ''}${value}`;
}

export function RecommendationLifecyclePanel({
  dealId,
  reloadToken,
}: {
  dealId: string;
  reloadToken: number;
}) {
  const [access, setAccess] = useState<AccessContext | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissAttempted, setDismissAttempted] = useState(false);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const accessResponse = await hubspot.fetch(`${API_BASE}/enterprise/access`, {
        method: 'GET',
        timeout: 15_000,
      });
      const accessData = await accessResponse.json();
      if (!accessResponse.ok) {
        throw new Error(accessData?.error?.message ?? 'DealGuard access could not be checked.');
      }
      const nextAccess = accessData as AccessContext;
      setAccess(nextAccess);
      const permissions = Array.isArray(nextAccess.permissions) ? nextAccess.permissions : [];
      if (!nextAccess.entitled || !permissionMatches(permissions, 'remediation.view')) {
        setRecommendations([]);
        return;
      }

      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/recommendations?limit=20`, {
        method: 'GET',
        timeout: 15_000,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message ?? 'Tracked recommendations could not be loaded.');
      }
      setRecommendations((data as RecommendationList).recommendations ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tracked recommendations could not be loaded.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load(false);
  }, [load, reloadToken]);

  const transition = useCallback(async (
    recommendationId: string,
    action: RecommendationTransition,
    reason?: string,
  ) => {
    setWorkingId(recommendationId);
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/recommendations/${recommendationId}/${action}`, {
        method: 'POST',
        timeout: 15_000,
        body: action === 'dismiss' ? { reason } : {},
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error?.message ?? 'The recommendation could not be updated.');
      }
      const updated = data as Recommendation;
      setRecommendations((items) => items.map((item) => item.id === updated.id ? updated : item));
      setDismissId(null);
      setDismissReason('');
      setDismissAttempted(false);
      setNotice(
        action === 'accept'
          ? 'Recommendation accepted.'
          : action === 'complete'
            ? 'Recommendation completed. A later Deal Brief will provide observational outcome evidence.'
            : 'Recommendation dismissed with its reason retained for audit and product-quality analysis.',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The recommendation could not be updated.');
    } finally {
      setWorkingId(null);
    }
  }, []);

  const permissions = Array.isArray(access?.permissions) ? access.permissions : [];
  const canView = permissionMatches(permissions, 'remediation.view');
  const canManage = permissionMatches(permissions, 'remediation.manage');
  const active = recommendations.filter((item) => item.status === 'presented' || item.status === 'accepted');
  const history = recommendations.filter((item) => item.status !== 'presented' && item.status !== 'accepted').slice(0, 4);

  if (loading) return <LoadingSpinner label="Loading tracked recommendations" />;

  if (!access?.entitled) {
    return <Alert title="Recommendation tracking is an Enterprise capability" variant="info">
      The current deterministic actions remain visible above. Enterprise adds acceptance, completion, dismissal, overdue tracking, and later observational outcome measurement.
    </Alert>;
  }

  if (!canView) {
    return <Alert title="Recommendation history is restricted" variant="warning">
      Your assigned role does not include the remediation.view permission for this deal's current scope.
    </Alert>;
  }

  return <Flex direction="column" gap="medium">
    <Divider />
    <Flex direction="row" justify="between" align="center" gap="small">
      <Flex direction="column" gap="extra-small">
        <Heading>Tracked recommendations</Heading>
        <Text>Accept, complete, or dismiss evidence-backed work without changing the deal record automatically.</Text>
      </Flex>
      <Button variant="secondary" disabled={refreshing || workingId !== null} onClick={() => void load(true)}>
        {refreshing ? 'Refreshing…' : 'Refresh history'}
      </Button>
    </Flex>

    {error && <Alert title="Recommendation action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Recommendation updated" variant="success">{notice}</Alert>}
    {!canManage && <Alert title="Read-only recommendation access" variant="info">
      Your role can review recommendation history but does not include remediation.manage. A permitted manager must accept, complete, or dismiss an action.
    </Alert>}

    {active.length === 0
      ? <Alert title="No active tracked recommendation" variant="success">
          No presented or accepted recommendation is currently open. Refresh the Deal Brief when new evidence is available.
        </Alert>
      : <Flex direction="column" gap="medium">
          {active.map((item, index) => <Flex key={item.id} direction="column" gap="extra-small">
            {index > 0 && <Divider />}
            <Flex direction="row" justify="between" align="center" gap="small">
              <Text format={{ fontWeight: 'bold' }}>{item.label}</Text>
              <Flex direction="row" gap="extra-small" wrap="wrap">
                <StatusTag variant={statusVariant(item.status)}>{statusLabel(item.status)}</StatusTag>
                <StatusTag variant={priorityVariant(item.priority)}>{item.priority} priority</StatusTag>
                {item.current && <StatusTag variant="success">Current Deal Brief</StatusTag>}
                {item.overdue && <StatusTag variant="danger">Overdue</StatusTag>}
              </Flex>
            </Flex>
            <Text>{item.action}</Text>
            <Text variant="microcopy">Owner: {ownerLabel(item.owner)} · Due: {formatDate(item.dueAt)} · Dimension: {item.dimension.replaceAll('_', ' ')}</Text>
            <Text variant="microcopy">Why: {item.rationale}</Text>
            {item.overdue && <Alert title="Accepted action is overdue" variant="warning">
              Accepted work remains open after its deadline; it is not silently expired or replaced.
            </Alert>}

            {canManage && <Flex direction="row" gap="small" wrap="wrap">
              {item.status === 'presented' && <Button
                disabled={workingId !== null}
                onClick={() => void transition(item.id, 'accept')}
              >{workingId === item.id ? 'Working…' : 'Accept'}</Button>}
              <Button
                disabled={workingId !== null}
                onClick={() => void transition(item.id, 'complete')}
              >{workingId === item.id ? 'Working…' : 'Mark complete'}</Button>
              <Button
                variant="secondary"
                disabled={workingId !== null}
                onClick={() => {
                  setDismissId(item.id);
                  setDismissReason('');
                  setDismissAttempted(false);
                }}
              >Dismiss</Button>
            </Flex>}

            {canManage && dismissId === item.id && <Flex direction="column" gap="small">
              <TextArea
                name={`dismiss-recommendation-${item.id}`}
                label="Dismissal reason"
                description="Required. Explain the customer or operating context so the decision remains auditable."
                placeholder="For example: the customer completed this outside HubSpot, or this step is not applicable to the current buying process."
                required={true}
                rows={3}
                maxLength={1000}
                resize="vertical"
                value={dismissReason}
                error={dismissAttempted && dismissReason.trim().length === 0}
                validationMessage={dismissAttempted && dismissReason.trim().length === 0
                  ? 'Enter a dismissal reason before continuing.'
                  : undefined}
                onChange={(value: string) => {
                  setDismissReason(value);
                  if (value.trim()) setDismissAttempted(false);
                }}
              />
              <Flex direction="row" gap="small">
                <Button
                  disabled={workingId !== null}
                  onClick={() => {
                    const reason = dismissReason.trim();
                    if (!reason) {
                      setDismissAttempted(true);
                      return;
                    }
                    void transition(item.id, 'dismiss', reason);
                  }}
                >Confirm dismissal</Button>
                <Button
                  variant="secondary"
                  disabled={workingId !== null}
                  onClick={() => {
                    setDismissId(null);
                    setDismissReason('');
                    setDismissAttempted(false);
                  }}
                >Cancel</Button>
              </Flex>
            </Flex>}
          </Flex>)}
        </Flex>}

    {history.length > 0 && <>
      <Divider />
      <Flex direction="column" gap="small">
        <Heading>Recent recommendation history</Heading>
        {history.map((item) => <Flex key={item.id} direction="column" gap="extra-small">
          <Flex direction="row" justify="between" align="center" gap="small">
            <Text format={{ fontWeight: 'bold' }}>{item.label}</Text>
            <StatusTag variant={statusVariant(item.status)}>{statusLabel(item.status)}</StatusTag>
          </Flex>
          <Text variant="microcopy">Presented {formatDate(item.presentedAt)}{item.completedAt ? ` · Completed ${formatDate(item.completedAt)}` : ''}</Text>
          {item.dismissalReason && <Text variant="microcopy">Dismissal reason: {item.dismissalReason}</Text>}
          {item.outcome?.evaluationStatus === 'pending' && <Text variant="microcopy">Awaiting a later Deal Brief before any outcome evidence can be observed.</Text>}
          {item.outcome?.observedProgress && <Alert
            title={`Observed ${outcomeLabel(item.outcome.observedProgress)}`}
            variant={outcomeVariant(item.outcome.observedProgress)}
          >
            {item.outcome.explanation ?? 'Later deterministic evidence was observed.'} Readiness delta: {signed(item.outcome.readinessDelta)}. Attention delta: {signed(item.outcome.attentionDelta)}. This is not causal attribution.
          </Alert>}
        </Flex>)}
      </Flex>
    </>}

    <Alert title="Outcome interpretation" variant="info">
      Completing an action does not prove impact. Later evidence is reported as an observed association only, and missing evidence is not treated as success or failure.
    </Alert>
  </Flex>;
}
