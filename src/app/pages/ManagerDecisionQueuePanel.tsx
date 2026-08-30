import React from 'react';
import { Flex } from '@hubspot/ui-extensions';
import { ExecutiveRevenuePanel } from './ExecutiveRevenuePanel';
import { ManagerDecisionQueuePanel as ManagerDecisionQueueCore } from './ManagerDecisionQueueCore';

export function ManagerDecisionQueuePanel({ enabled }: { enabled: boolean }) {
  return <Flex direction="column" gap="large">
    <ManagerDecisionQueueCore enabled={enabled} />
    <ExecutiveRevenuePanel enabled={enabled} />
  </Flex>;
}
