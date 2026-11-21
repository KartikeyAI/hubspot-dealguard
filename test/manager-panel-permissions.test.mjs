import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hookHarness } from './helpers/ui-hook-harness.mjs';

const permissionCode=ts.transpileModule(readFileSync('src/app/pages/product-ui.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText;
const modules={'./product-ui':await import(`data:text/javascript;base64,${Buffer.from(permissionCode).toString('base64')}`)};
const names=['BreezeAdministrationPanel','IntelligenceAssistancePanel','OutcomeEvaluationPanel','ForecastAdministrationPanel','RemediationWorkPanel','WebhookHealthPanel','BackgroundIntelligencePanel','PortfolioHistoryPanel','ExecutiveRevenuePanel','RecommendationDeliveryAnalyticsPanel','RecommendationDeliverySloPanel','RecommendationNotificationConfigurationPanel','RecommendationOperationsPanel','RecommendationOutcomePanel','RecommendationRoutingPoliciesPanel'];
const stub=name=>Object.assign(()=>null,{panel:name});
for(const name of names)modules[`./${name}`]={[name]:stub(name)};
modules['./ManagerDecisionQueueCore']={ManagerDecisionQueuePanel:stub('ManagerDecisionQueueCore')};
const nodes=value=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const scope={pipelineIds:[],ownerIds:[],teamIds:[],regionCodes:[]};
function panels(t,props) {
  const host=hookHarness('src/app/pages/ManagerDecisionQueuePanel.tsx','ManagerDecisionQueuePanel',props,()=>{throw new Error('Composition must not contact a provider');},modules);
  t.after(()=>host.dispose());return Object.fromEntries(nodes(host.current).filter(n=>n.type?.panel).map(n=>[n.type.panel,n.props]));
}

test('billing-only roles do not mount executive, portfolio or manager analytics',t=>{
  const p=panels(t,{enabled:true,administrationEnabled:false,access:{role:'billing_administrator',permissions:['billing.view','billing.manage'],scope,explicitAssignment:true}});
  for(const name of ['ManagerDecisionQueueCore','ExecutiveRevenuePanel','PortfolioHistoryPanel','RecommendationOperationsPanel'])assert.equal(p[name],undefined,name);
  assert.equal(p.IntelligenceAssistancePanel.enabled,false);assert.equal(p.OutcomeEvaluationPanel.enabled,false);assert.equal(p.BreezeAdministrationPanel.enabled,false);
  assert.equal(p.ForecastAdministrationPanel.canInspect,false);assert.equal(p.ForecastAdministrationPanel.canForecast,false);
});

test('scoped analytics viewers receive permitted read panels without portal administration or refresh operations',t=>{
  const p=panels(t,{enabled:true,administrationEnabled:false,access:{role:'viewer',permissions:['analytics.view','remediation.view','alert.view'],scope:{...scope,ownerIds:['7']},explicitAssignment:true}});
  for(const name of ['ManagerDecisionQueueCore','ExecutiveRevenuePanel','PortfolioHistoryPanel'])assert.equal(p[name]?.enabled,true,name);
  for(const name of ['BackgroundIntelligencePanel','WebhookHealthPanel','RecommendationNotificationConfigurationPanel','RecommendationRoutingPoliciesPanel','RecommendationDeliveryAnalyticsPanel'])assert.equal(p[name],undefined,name);
  assert.equal(p.IntelligenceAssistancePanel.canGenerate,false);assert.equal(p.OutcomeEvaluationPanel.enabled,false);
  assert.equal(p.ForecastAdministrationPanel.canForecast,true);assert.equal(p.ForecastAdministrationPanel.canInspect,false);
});

test('expired administrators retain revocation without mounting paid analytics or admitting new intelligence work',t=>{
  const p=panels(t,{enabled:false,administrationEnabled:true,access:{role:'administrator',permissions:['*'],scope,explicitAssignment:true}});
  for(const name of ['ManagerDecisionQueueCore','ExecutiveRevenuePanel','PortfolioHistoryPanel'])assert.equal(p[name],undefined,name);
  assert.equal(p.IntelligenceAssistancePanel.enabled,true);assert.equal(p.IntelligenceAssistancePanel.canGenerate,false);
  assert.equal(p.OutcomeEvaluationPanel.enabled,true);assert.equal(p.OutcomeEvaluationPanel.canEvaluate,false);
  assert.equal(p.BreezeAdministrationPanel.enabled,true);assert.equal(p.BreezeAdministrationPanel.canEnable,false);
  assert.equal(p.ForecastAdministrationPanel.canInspect,true);assert.equal(p.ForecastAdministrationPanel.entitled,false);assert.equal(p.ForecastAdministrationPanel.canForecast,false);
});

test('legacy or installer authorization is not presented as explicit forecast reviewer assignment',t=>{
  const p=panels(t,{enabled:true,administrationEnabled:true,access:{role:'administrator',permissions:['*'],scope,bootstrap:false,explicitAssignment:false}});
  assert.equal(p.ForecastAdministrationPanel.canInspect,false);assert.equal(p.ForecastAdministrationPanel.canAdminister,false);assert.equal(p.ForecastAdministrationPanel.canReview,false);
});
