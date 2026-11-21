import { BreezeAdministrationPanel } from './BreezeAdministrationPanel';
import { IntelligenceAssistancePanel } from './IntelligenceAssistancePanel';
import { OutcomeEvaluationPanel } from './OutcomeEvaluationPanel';
import { ForecastAdministrationPanel } from './ForecastAdministrationPanel';
import { RemediationWorkPanel } from './RemediationWorkPanel';
import { WebhookHealthPanel } from './WebhookHealthPanel';
import { BackgroundIntelligencePanel } from './BackgroundIntelligencePanel';
import React from 'react';
import { productPermissionAvailable } from './product-ui';
import { Flex } from '@hubspot/ui-extensions';
import { PortfolioHistoryPanel } from './PortfolioHistoryPanel';
import { ExecutiveRevenuePanel } from './ExecutiveRevenuePanel';
import { ManagerDecisionQueuePanel as ManagerDecisionQueueCore } from './ManagerDecisionQueueCore';
import { RecommendationDeliveryAnalyticsPanel } from './RecommendationDeliveryAnalyticsPanel';
import { RecommendationDeliverySloPanel } from './RecommendationDeliverySloPanel';
import { RecommendationNotificationConfigurationPanel } from './RecommendationNotificationConfigurationPanel';
import { RecommendationOperationsPanel } from './RecommendationOperationsPanel';
import { RecommendationOutcomePanel } from './RecommendationOutcomePanel';
import { RecommendationRoutingPoliciesPanel } from './RecommendationRoutingPoliciesPanel';

export function ManagerDecisionQueuePanel({ enabled, administrationEnabled = false, access }: { enabled: boolean; administrationEnabled?: boolean; access?: unknown }) {
  const analytics = enabled && productPermissionAvailable(access, 'analytics.view');
  const canUseAi = enabled && productPermissionAvailable(access, 'ai.use') && analytics;
  const assigned = (access as {explicitAssignment?:boolean}|undefined)?.explicitAssignment === true;
  const role = (access as {role?:string}|undefined)?.role;
  const forecastAdministrator = assigned && administrationEnabled;
  const forecastReviewer = assigned && ['administrator','reviewer','compliance_auditor'].includes(role??'')
    && productPermissionAvailable(access,'forecast.approve',true);
  const portalPermission = (permission:string) => enabled && productPermissionAvailable(access, permission, true);
  return <Flex direction="column" gap="large">
    {analytics && <ManagerDecisionQueueCore enabled={analytics} />}
    {enabled && productPermissionAvailable(access,'remediation.view') && <RemediationWorkPanel enabled={enabled} />}
    {analytics && <ExecutiveRevenuePanel enabled={analytics} />}
    {analytics && <PortfolioHistoryPanel enabled={analytics} />}
    {portalPermission('scan.run') && <BackgroundIntelligencePanel enabled={enabled} />}
    {portalPermission('scan.run') && <WebhookHealthPanel enabled={enabled} />}
    {analytics && <RecommendationOutcomePanel enabled={analytics} />}
    <IntelligenceAssistancePanel enabled={canUseAi || administrationEnabled} canGenerate={canUseAi} canAdminister={administrationEnabled} />
    <OutcomeEvaluationPanel enabled={administrationEnabled} canEvaluate={enabled} />
    <ForecastAdministrationPanel canForecast={analytics} canInspect={forecastAdministrator||forecastReviewer}
      canAdminister={forecastAdministrator} canReview={forecastReviewer} entitled={enabled} />
    <BreezeAdministrationPanel enabled={administrationEnabled} canEnable={enabled} />
    {analytics && <RecommendationOperationsPanel enabled={analytics} />}
    {portalPermission('alert.view') && <RecommendationNotificationConfigurationPanel enabled={enabled} />}
    {portalPermission('alert.view') && <RecommendationRoutingPoliciesPanel enabled={enabled} />}
    {portalPermission('alert.view') && <RecommendationDeliveryAnalyticsPanel enabled={enabled} />}
    {portalPermission('reliability.view') && <RecommendationDeliverySloPanel enabled={enabled} />}
  </Flex>;
}
