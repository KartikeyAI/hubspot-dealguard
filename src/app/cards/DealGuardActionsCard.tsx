import React from 'react';
import { Alert, Button, Divider, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, formatDate, useDealAssessment } from './deal-intelligence-shared';
import { RecommendationLifecyclePanel } from './deal-recommendation-lifecycle';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardActionsCard dealId={String(context.crm.objectId)} />);

const DealGuardActionsCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  const [recommendationReload, setRecommendationReload] = React.useState(0);

  const refreshActions = async () => {
    await load(true);
    setRecommendationReload((value) => value + 1);
  };

  if (loading) return <CardLoading label="Loading DealGuard actions" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const intelligence = assessment.intelligence;
  const decisionActions = intelligence?.decisionActions ?? [];
  const readinessActions = intelligence?.nextBestActions ?? [];

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Heading>Recommended actions</Heading>
    {decisionActions.length === 0
      ? <Alert title="No evidence-backed intervention detected" variant="success">DealGuard has no additional momentum, close-date, relationship, engagement, or commercial-integrity action for this deal.</Alert>
      : <Flex direction="column" gap="small">
          <Text>Prioritised from structured CRM movement, close-date, relationship, activity metadata, and optional quote and line-item evidence. DealGuard does not inspect communication or proposal content and does not autonomously edit commercial fields or stakeholder roles.</Text>
          {decisionActions.map((item, index) => <Flex key={item.code} direction="column" gap="extra-small">
            <Flex direction="row" justify="between" gap="small">
              <Text format={{ fontWeight: 'bold' }}>{index + 1}. {item.label}</Text>
              <StatusTag variant={item.priority === 'high' ? 'danger' : item.priority === 'medium' ? 'warning' : 'default'}>{item.priority}</StatusTag>
            </Flex>
            <Text>{item.action}</Text>
            <Text variant="microcopy">Owner: {item.owner === 'deal_owner' ? 'Deal owner' : 'Sales manager'} · Due: {formatDate(item.dueAt)}</Text>
            <Text variant="microcopy">Why: {item.rationale}</Text>
          </Flex>)}
        </Flex>}

    <RecommendationLifecyclePanel dealId={dealId} reloadToken={recommendationReload} />

    <Divider />
    <Heading>Readiness fixes</Heading>
    {readinessActions.length === 0
      ? <Text>No deterministic readiness remediation is currently required.</Text>
      : <Flex direction="column" gap="small">
          {readinessActions.map((item, index) => <Flex key={item.code} direction="column" gap="extra-small">
            <Text format={{ fontWeight: 'bold' }}>{index + 1}. {item.action}</Text>
            <Text variant="microcopy">Potential readiness impact: +{item.impact} · {item.label}</Text>
          </Flex>)}
        </Flex>}
    <Button variant="secondary" onClick={() => void refreshActions()} disabled={working}>Refresh actions</Button>
    <Text variant="microcopy">Based on assessment from {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
