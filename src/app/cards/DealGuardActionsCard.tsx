import React from 'react';
import { Alert, Button, Flex, Heading, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, useDealAssessment } from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardActionsCard dealId={String(context.crm.objectId)} />);

const DealGuardActionsCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard actions" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const intelligence = assessment.intelligence;
  const actions = intelligence?.nextBestActions ?? [];

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Heading>Next best actions</Heading>
    {actions.length === 0 ? <Alert title="No remediation needed" variant="success">DealGuard has no detected readiness actions for this deal.</Alert> : <>
      <Text>Prioritised by readiness-point impact. These actions explain what to fix; DealGuard does not autonomously change commercial deal fields.</Text>
      <Flex direction="column" gap="small">
        {actions.map((item, index) => <Flex key={item.code} direction="column" gap="extra-small">
          <Text><Text format={{ fontWeight: 'bold' }}>{index + 1}. {item.action}</Text></Text>
          <Text variant="microcopy">Potential readiness impact: +{item.impact} · {item.label}</Text>
        </Flex>)}
      </Flex>
    </>}
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh actions</Button>
    <Text variant="microcopy">Based on assessment from {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
