# Consented outcome datasets and held-out evaluation

## Product boundary

This is an optional Enterprise evaluation capability, not a live deal forecast.
The deterministic readiness/attention scores remain separate from outcome
probabilities. All public evaluation responses retain `predictionsEnabled: false`.
An administrator must grant the separate `outcomes` consent; AI or Breeze consent
is neither required nor a substitute. Revocation remains available after paid
entitlement expires.

## Cohort definition

The initial target is a **recorded open deal at the beginning of a quarter and a
recorded closed-won state by that quarter's end**. A requested quarter must have
matured by at least seven days. Baseline evidence must be observed no later than
the quarter boundary and no more than 72 hours earlier; the end label similarly
requires recent retained evidence before the end boundary. Missing, stale,
archived, invalid or incompatible observations are explicitly excluded rather
than labeled as losses.

The cohort is scoped to one tenant, pipeline and policy. The policy must already
have existed at the prediction boundary; incompatible pipeline/policy transitions
are excluded. The features are readiness score, issue count, recorded stage age
and a stage-age missingness indicator. Customer names, amounts, communication
bodies and contact payloads are not modeling features. The underlying data remain
observational and cannot establish causal revenue impact.

Dataset creation checks the current consent revision and active portal. Manifests
record the requested boundary, methodology, inclusion/exclusion counts and a
canonical fingerprint of the retained samples, plus a versioned-policy content
fingerprint. Repeated identical requests are
idempotent. The builder refuses an over-capacity request rather than silently
turning a partial 10,000-deal result into a complete cohort. Dataset rows are
immutable through ordinary updates. The administrator listing returns manifests,
not raw sample arrays.

## Evaluation

Interactive evaluation requests enqueue a durable, bounded job. The maintenance
worker claims and fits the data independently of CRM reads, with leases, bounded
retries and visible queued/running/completed/failed states. Current consent, assigned
administrator identity, policy fingerprints and entitlement are rechecked. Legacy
datasets without a policy fingerprint must be rebuilt for this controlled path.

Three dataset IDs identify training, calibration and holdout cohorts. Their time
boundaries must be ordered and non-overlapping. A deal observed in an earlier
split is removed from later splits before eligibility is assessed. There are at
most 2,000 samples per split; required minima are 200 training, 100 calibration and
100 holdout observations, with at least 20 observations of each class per split.
These are explicit implementation thresholds, not a claim of statistical adequacy
for every customer population.

The candidate is a regularized logistic model with training-only feature
standardization. A temperature parameter is selected using calibration data;
holdout data are used only for the report. The comparison baseline is the training
outcome frequency. Reports include Brier score, log loss, ten-bin calibration
error, tie-aware AUC and a seeded approximate bootstrap interval for the Brier
score difference. The initial qualification rule requires an upper Brier
improvement bound below -0.001, lower log loss, calibration error no greater than
0.1 and AUC at least 0.6. Insufficient or invalid evidence yields an explicit
unqualified state. An approximate interval is not a production forecasting SLA.

Stored reports bind the exact dataset fingerprints, consent revision and model
methodology. Evaluation does not install an active model, populate a CRM win
probability, alter an opportunity, or enable predictions. The separate production
eligibility mechanism in `QUALIFIED_FORECASTING.md` adds an immutable registry,
independent review, original quarter-anchor inference, cache, drift/outcome monitoring
and kill switches. Actual representative tenant evaluation and approval are still
required before customer probabilities may be enabled.

## Access, retention and interfaces

A signed stable HubSpot user identity, active portal, portal-wide administrator
role and the applicable Enterprise entitlement are required for generation and
inspection. The API rechecks permissions and consent rather than treating the
requested dataset IDs as authorization. Tenant-local keys and foreign keys prevent
cross-tenant dataset/evaluation combinations.

Dataset/evaluation retention is 180 days unless a legal hold applies. Consent
revocation deletes eligible retained data; held records are retained for the hold
but cannot be used through revoked consent. Disconnect/deletion also revokes
consent, and reactivation does not restore it automatically.

Endpoints under `/api/v1/enterprise/outcome-evaluation` provide `consent`,
`datasets` and `evaluations`. App Home exposes a native `OutcomeEvaluationPanel`
for the existing APIs. It shows manifests, counts and metrics, not an invented
forecast or raw training data. The separate forecast panel reports activation and
record eligibility honestly. Automated synthetic validation is not a live customer
qualification or production release; use the exact candidate validation record.
