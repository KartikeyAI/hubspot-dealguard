import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const failures = [];

function record(name, condition, details = '') {
  const passed = Boolean(condition);
  checks.push({ name, passed, details });
  if (!passed) failures.push(details ? `${name}: ${details}` : name);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parseJson(relativePath) {
  try {
    return JSON.parse(read(relativePath));
  } catch (error) {
    failures.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

const migrationDir = path.join(root, 'database', 'migrations');
const migrationFiles = fs.readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const migrationNumbers = migrationFiles.map((name) => Number(name.slice(0, 4)));
const expectedMigrationNumbers = Array.from({ length: 22 }, (_, index) => index + 1);
record(
  'PostgreSQL migration sequence is contiguous through 0022',
  JSON.stringify(migrationNumbers) === JSON.stringify(expectedMigrationNumbers),
  `found ${migrationFiles.join(', ')}`,
);

for (const number of Array.from({ length: 8 }, (_, index) => index + 15)) {
  const prefix = String(number).padStart(4, '0');
  const matches = migrationFiles.filter((name) => name.startsWith(`${prefix}_`));
  record(`Migration ${prefix} exists exactly once`, matches.length === 1, `found ${matches.length}`);
  if (matches.length === 1) {
    const sql = read(path.join('database', 'migrations', matches[0]));
    record(`Migration ${prefix} targets the DealGuard schema`, /SET\s+search_path\s+TO\s+dealguard\s*,\s*public\s*;/i.test(sql));
    record(`Migration ${prefix} contains no SQLite PRAGMA`, !/\bPRAGMA\b/i.test(sql));
  }
}

const expectedMigrationEvidence = new Map([
  ['0015', ['deal_currency_code', 'deal_amount_in_company_currency']],
  ['0016', ['deal_decision_snapshots']],
  ['0017', ['executive_revenue_snapshots']],
  ['0018', ['recommendation_instances', 'recommendation_events', 'recommendation_outcomes']],
  ['0019', ['recommendation_followup_batches', 'recommendation_followup_items']],
  ['0020', ['recommendation_routing_policies', 'recommendation_policy_dispatches']],
  ['0021', ['recommendation_delivery_events']],
  ['0022', [
    'recommendation_delivery_slo_policies',
    'recommendation_delivery_slo_states',
    'recommendation_delivery_slo_incidents',
    'recommendation_delivery_slo_notifications',
  ]],
]);
for (const [prefix, markers] of expectedMigrationEvidence.entries()) {
  const file = migrationFiles.find((name) => name.startsWith(`${prefix}_`));
  if (!file) continue;
  const sql = read(path.join('database', 'migrations', file));
  for (const marker of markers) record(`Migration ${prefix} contains ${marker}`, sql.includes(marker));
}

const routeIndex = read('worker/src/index.ts');
record('Worker entrypoint activates routes-v17', /from ['"]\.\/routes-v17\.js['"]/.test(routeIndex));
for (let version = 11; version <= 17; version += 1) {
  const routePath = `worker/src/routes-v${version}.ts`;
  record(`${routePath} exists`, exists(routePath));
  if (!exists(routePath)) continue;
  const source = read(routePath);
  record(
    `${routePath} delegates to routes-v${version - 1}`,
    new RegExp(`from ['"]\\.\\/routes-v${version - 1}\\.js['"]`).test(source),
  );
}

const postgres = read('worker/src/postgres.ts');
const relations = [
  'deal_decision_snapshots',
  'executive_revenue_snapshots',
  'recommendation_instances',
  'recommendation_events',
  'recommendation_outcomes',
  'recommendation_followup_batches',
  'recommendation_followup_items',
  'recommendation_routing_policies',
  'recommendation_policy_dispatches',
  'recommendation_delivery_events',
  'recommendation_delivery_slo_policies',
  'recommendation_delivery_slo_states',
  'recommendation_delivery_slo_incidents',
  'recommendation_delivery_slo_notifications',
];
for (const relation of relations) record(`Neon adapter qualifies ${relation}`, postgres.includes(`'${relation}'`));

const packageJson = parseJson('package.json');
if (packageJson) {
  const scripts = packageJson.scripts ?? {};
  record('Package exposes release convergence validation', scripts['release:convergence'] === 'node scripts/release-convergence.mjs');
  record('Package exposes intelligence acceptance', scripts['acceptance:intelligence'] === 'node scripts/intelligence-acceptance.mjs');
  for (const validator of [
    'postgres-validate.mjs',
    'postgres-validate-recommendation-operations.mjs',
    'postgres-validate-delivery-analytics.mjs',
    'postgres-validate-delivery-slos.mjs',
  ]) {
    record(`Canonical db:validate includes ${validator}`, String(scripts['db:validate'] ?? '').includes(validator));
  }
}

const appMetadata = parseJson('src/app/app-hsmeta.json');
if (appMetadata) {
  const auth = appMetadata?.config?.auth ?? {};
  const requiredScopes = [...(auth.requiredScopes ?? [])].sort();
  const optionalScopes = [...(auth.optionalScopes ?? [])].sort();
  const expectedRequired = [
    'crm.objects.companies.read',
    'crm.objects.contacts.read',
    'crm.objects.deals.read',
    'crm.objects.deals.write',
    'crm.schemas.deals.read',
    'crm.schemas.deals.write',
  ].sort();
  const expectedOptional = ['crm.objects.line_items.read', 'crm.objects.quotes.read'].sort();
  record('Required OAuth scope set remains least-privilege and stable', JSON.stringify(requiredScopes) === JSON.stringify(expectedRequired), requiredScopes.join(', '));
  record('Commercial OAuth scopes remain optional', JSON.stringify(optionalScopes) === JSON.stringify(expectedOptional), optionalScopes.join(', '));
  record('Invalid legacy task scope is absent', !requiredScopes.includes('crm.objects.tasks.write'));
}

const manifests = [
  'hsproject.json',
  'src/app/app-hsmeta.json',
  'src/app/cards/dealguard-card-hsmeta.json',
  'src/app/settings/dealguard-settings-hsmeta.json',
  'src/app/pages/pages-hsmeta.json',
  'src/app/webhooks/deal-events-hsmeta.json',
  'src/app/workflow-actions/assess-deal-hsmeta.json',
  'src/app/workflow-actions/create-remediation-hsmeta.json',
];
for (const manifest of manifests) {
  record(`${manifest} exists`, exists(manifest));
  if (exists(manifest)) record(`${manifest} is valid JSON`, parseJson(manifest) !== null);
}

const composition = read('src/app/pages/ManagerDecisionQueuePanel.tsx');
for (const panel of [
  'ManagerDecisionQueueCore',
  'ExecutiveRevenuePanel',
  'RecommendationOutcomePanel',
  'RecommendationOperationsPanel',
  'RecommendationNotificationConfigurationPanel',
  'RecommendationRoutingPoliciesPanel',
  'RecommendationDeliveryAnalyticsPanel',
  'RecommendationDeliverySloPanel',
]) record(`App Home composes ${panel}`, composition.includes(panel));

for (const requiredPath of [
  'docs/ENTERPRISE_ANALYTICS.md',
  'docs/DEAL_MOMENTUM_AND_CLOSE_DATE.md',
  'docs/BUYER_COMMITTEE_INTELLIGENCE.md',
  'docs/DEAL_BRIEF.md',
  'docs/ENGAGEMENT_INTELLIGENCE.md',
  'docs/COMMERCIAL_INTEGRITY.md',
  'docs/MANAGER_DECISION_QUEUE.md',
  'docs/EXECUTIVE_REVENUE_VIEW.md',
  'docs/RECOMMENDATION_OUTCOMES.md',
  'docs/RECOMMENDATION_OPERATIONS.md',
  'docs/RECOMMENDATION_ROUTING_SLAS.md',
  'docs/RECOMMENDATION_DELIVERY_SLA_ANALYTICS.md',
  'docs/RECOMMENDATION_DELIVERY_SLO_ALERTS.md',
  'docs/RELEASE_CONVERGENCE.md',
  'scripts/intelligence-acceptance.mjs',
]) record(`${requiredPath} exists`, exists(requiredPath));

const forbiddenPaths = [
  'docs/.commercial-integrity-validation',
  'docs/.do-not-create',
  'docs/.routing-sla-validation',
  'database/migrations/0020_recommendation_recipient_hash_guard.sql',
  'worker/src/recommendation-follow-ups.ts',
];
for (const forbiddenPath of forbiddenPaths) record(`${forbiddenPath} is absent`, !exists(forbiddenPath));

const repositoryText = [
  read('src/app/app-hsmeta.json'),
  read('worker/src/index.ts'),
  read('worker/src/config.ts'),
].join('\n');
record('Invalid crm.objects.tasks.write scope is absent from release-critical sources', !repositoryText.includes('crm.objects.tasks.write'));

const result = {
  ok: failures.length === 0,
  generatedAt: new Date().toISOString(),
  migrationRange: { first: '0001', last: '0022', releaseStart: '0015', releaseEnd: '0022' },
  checks: { total: checks.length, passed: checks.filter((item) => item.passed).length, failed: failures.length },
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
