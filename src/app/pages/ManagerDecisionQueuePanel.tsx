import React from 'react';
import { Flex } from '@hubspot/ui-extensions';
import { ExecutiveRevenuePanel } from './ExecutiveRevenuePanel';
import { ManagerDecisionQueuePanel as ManagerDecisionQueueCore } from './ManagerDecisionQueueCore';
import { RecommendationOperationsPanel } from './RecommendationOperationsPanel';
import { RecommendationOutcomePanel } from './RecommendationOutcomePanel';
import { RecommendationRoutingPoliciesPanel } from './RecommendationRoutingPoliciesPanel';

export function ManagerDecisionQueuePanel({ enabled }: { enabled: boolean }) {
  return <Flex direction="column" gap="large">
    <ManagerDecisionQueueCore enabled={enabled} />
    <ExecutiveRevenuePanel enabled={enabled} />
    <RecommendationOutcomePanel enabled={enabled} />
    <RecommendationOperationsPanel enabled={enabled} />
    <RecommendationRoutingPoliciesPanel enabled={enabled} />
  </Flex>;
}
