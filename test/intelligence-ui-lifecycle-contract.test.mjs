import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
const source=p=>readFileSync(p,'utf8');
test('expired-subscription UI preserves administrative revocation without enabling new optional work',()=>{
 const home=source('src/app/pages/EnterpriseHomeV4.tsx'),panels=source('src/app/pages/ManagerDecisionQueuePanel.tsx');
 assert.match(home,/administrationEnabled=\{setupAdministrator\}/);
 assert.match(panels,/<IntelligenceAssistancePanel enabled=\{canUseAi \|\| administrationEnabled\} canGenerate=\{canUseAi\} canAdminister=\{administrationEnabled\}/);
 assert.match(panels,/<OutcomeEvaluationPanel enabled=\{administrationEnabled\} canEvaluate=\{enabled\}/);
 assert.match(panels,/<BreezeAdministrationPanel enabled=\{administrationEnabled\} canEnable=\{enabled\}/);
 assert.match(source('src/app/pages/OutcomeEvaluationPanel.tsx'),/c\.enabled&&canEvaluate\?await Promise\.all/);
 assert.match(source('worker/src/routes-v10.ts'),/billingAccessFallback\(env, identity\)/);
});
test('setup report and scoped Home dispatch before the legacy portal dashboard',()=>{
 const router=source('worker/src/routes-intelligence.ts');assert.match(router,/path==='\/api\/v1\/dashboard'/);assert.match(router,/dashboardForIdentity\(env,identity,url\)/);
 const home=source('src/app/pages/EnterpriseHomeV4.tsx');assert.doesNotMatch(home,/Pipeline is in good shape/);assert.doesNotMatch(home,/dashboard\.averageScore \?\? 0/);
 assert.match(home,/No recorded open-deal evidence/);assert.match(home,/Health unverified/);
 const onboarding=source('src/app/pages/OnboardingChecklistPanel.tsx');assert.doesNotMatch(onboarding,/method:'(?:POST|PUT|DELETE)'/);assert.match(onboarding,/not production certification/);
});
