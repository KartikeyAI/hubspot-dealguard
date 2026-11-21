# Qualified quarter-anchor forecasts

## Product and activation boundary

The v3 implementation provides a controlled evaluation queue, an immutable model
registry, independent approval, retained-evidence inference, an inference cache,
feature-drift and mature-outcome monitoring, and operator/tenant kill switches.
These mechanisms do not mean that any customer model is qualified or enabled.
`DEALGUARD_FORECAST_ENABLED` defaults off. Outcomes consent, a separate tenant
forecast switch, a qualified registered model, an independent evidence-bound
review, current monitoring, and record-level eligibility are all required.
No model or review is installed by a migration or by test fixtures.

The target is a **recorded open deal at quarter start and a recorded closed-won
state near that quarter's end**. This is separate from readiness, management
priority, evidence quality, recommendation usefulness and causal business impact.
The forecast is calculated from retained quarter-start observations, not arbitrary
current-deal fields. A new estimate of a current snapshot requires a separately
defined and evaluated model; this implementation does not silently substitute one.

## Controlled evaluation and artifact provenance

`POST /api/v1/enterprise/outcome-evaluation/evaluations` enqueues a durable job;
it performs no model fitting in the interactive request. A bounded maintenance
batch claims one job by default using `FOR UPDATE SKIP LOCKED`, a five-minute
lease and at most three attempts. Expired leases are recoverable. A repeat request
for the same three datasets/consent returns the same job. Transient failures can
be explicitly retried through that request, with a thirty-second delay and the
same attempt ceiling. Permanent failures remain visible. Admission is limited
to ten new evaluation jobs per portal in a rolling day.

Each split has at most 2,000 samples. The current fitting loop is fixed at four
features and 400 gradient iterations; calibration considers six temperatures;
the Brier-difference bootstrap uses 200 seeded draws. A local Node execution of
the maximum 6,000-sample shape took approximately 68 milliseconds during development.
This is not a Cloudflare CPU measurement, throughput commitment or load acceptance.
A Worker interrupted before completion leaves a lease that can be recovered;
failed or incomplete work cannot activate a model. Representative Worker/Neon
load and queue-lag measurements remain production acceptance requirements.

New datasets bind a fingerprint of their versioned policy contents. Legacy
manifests without this binding must be rebuilt for controlled forecast evaluation.
Dataset integrity, current consent, current assigned administrator, entitlement
and policy identity are checked before batch processing and result acceptance.
Training/calibration/holdout splits remain time-separated, with shared deal
identities removed from later splits. See `OUTCOME_DATASETS_AND_EVALUATION.md`
for feature and metric definitions.

The immutable artifact records its evaluation and dataset fingerprints, policy
fingerprint, feature schema, model parameters, training profile, holdout calibration
bins, evaluation report, consent revision and source quarters. A fitted model
that fails the predefined historical gate cannot be registered for activation.
A qualified report remains a candidate until reviewed independently.

## Registration, review and controls

All API requests require the existing verified HubSpot request identity.
Registration and controls require an **explicitly assigned**, portal-wide
administrator with a stable HubSpot user ID. Installer bootstrap and email-only
fallback are insufficient. Review permits an explicitly assigned administrator,
or a portal-wide reviewer/compliance auditor with `forecast.approve`.

The reviewer must differ from both the evaluation requester and model registrant.
Review binds the exact artifact fingerprint and the SHA-256 digest of retained
independent validation evidence. An authenticated review records who approved
which evidence. A digest alone does not prove that the evidence is truthful or
sufficient, and this approval does not provide production release sign-off.

Registration requires a qualified evaluation completed in the last seven days.
The holdout must precede the current quarter and end within the last 180 days.
A candidate expires within thirty days and before its source datasets expire.
At most twenty candidates can be registered per portal per rolling day; an
identical artifact cannot have duplicate pending registrations. A newly approved
candidate supersedes the prior active model for the same tenant/pipeline/policy.

Both switches are necessary. The global environment flag defaults false. The
separate tenant switch defaults false and requires `ENABLE_FORECASTS`. An
administrator can disable it after entitlement expires. `DISABLE_FORECASTS`
suspends pending/active models and clears eligible caches; enabling the switch
again does not restore those approvals. A new candidate/review is required.

## Inference and failure states

The signed `GET /api/v1/enterprise/forecast/deal?dealId=...` endpoint requires a
stable identified user, Enterprise entitlement, `analytics.view`, current recorded
deal scope and the scope of the retained quarter-anchor evidence. The current
deal must be available and open, with a fresh or aging current assessment. The
anchor must be observed no more than 72 hours before quarter start and must match
the model's exact pipeline, policy and feature contract. A recorded intervening
closure, pipeline change or policy change makes that deal ineligible.

The server verifies the immutable artifact and policy fingerprint, current
consent, both switches, model expiry, reviewer authorization, monitoring expiry,
source evidence and current permissions. Those checks run again before returning
a result, including a cache hit. Each displayed estimate also needs at least
twenty held-out observations in its probability bin. Missing/invalid/stale evidence,
revoked access, sparse calibration support, policy changes or drift return an
explicit unavailable state with `probability: null`. Unavailable never means zero.

The retained forecast is bound to tenant/model/deal/quarter and original source
fingerprint; it is immutable. A fifteen-minute cache also binds consent and control
revisions and expires no later than the model, monitor or horizon. A cached number
is never authority to bypass current authorization. The service never writes a
HubSpot probability, changes an opportunity, sends a message, or executes an AI tool.

## Uncertainty and monitoring

Customer output includes the model's point estimate, target, quarter anchor,
horizon, original evidence time and current assessment time. It also shows the
held-out probability bin's observation count, recorded win rate and Wilson 95%
interval. That interval describes a historical group rate. It is **not** a
confidence interval for an individual deal probability; that field remains null.
These estimates do not imply a revenue amount, expected loss or causal improvement.

Bounded maintenance observes the retained current-quarter cohort, up to 10,000
deals, without new CRM/provider calls. A monitor requires at least 100 valid
anchors, at most 20% exclusions within the recorded pipeline cohort and feature
histogram total-variation distance no greater than 0.25 against training. These
are predefined conservative drift indicators, not universal statistical guarantees.
Missing/capacity-exceeded/invalid evidence fails closed. Checks are due every
twelve hours and expire after twenty-four. An active model with failed monitoring
is suspended; a view read does not retrain or refresh it.

After a forecast quarter matures by seven days, a separate bounded maintenance
observation compares retained predictions with recent pre-horizon recorded labels.
Missing, stale, archived or incompatible labels are excluded, never counted as
losses. At least 100 observations and twenty examples of each class are required
for performance metrics. Reports retain sample/exclusion counts, Brier score,
log loss, calibration error, baseline comparison and a label-evidence fingerprint.
Observed deterioration suspends an active model. Reports and prediction records
are immutable and tenant-bound. Historical observations are not customer-pilot
or production-accuracy evidence merely because the monitoring code exists.

## Data lifecycle and interfaces

Consent changes cancel pending evaluations, disable tenant controls, suspend models
and invalidate eligible caches. Installation deactivation invokes those same
consent changes; reinstalling does not reactivate them. Non-held outcome deletion
cascades through evaluations, jobs, models, predictions, caches and reports. Tenant
deletion cascades all seven new tables. Legal holds retain protected evidence but
do not permit its use or disclosure after revocation. Administrative controls stay
available after expiry; model/outcome report details require current consent and
paid access and are rechecked before response. Ordinary data retention follows the
180-day outcome evidence boundary; caches expire independently, and expired model
state never authorizes inference even when a hold retains its rows.

| Endpoint | Action |
|---|---|
| `GET .../forecast/status` | Current controls, permitted model/monitor/report summaries |
| `GET .../forecast/deal?dealId=...` | Scope-checked eligibility and optional anchored estimate |
| `PUT .../forecast/controls` | Revision-checked enable or kill switch |
| `POST .../forecast/models` | Register a qualified evaluation as a pending candidate |
| `POST .../forecast/review` | Independent fingerprint/evidence-bound approve or reject |

The App Home exposes these operations on demand, including registration and
independent review; no developer console is needed for normal administrative work.
No customer model, independent validation report, live prediction, customer data
training, provider call or production deployment was created by the development
fixtures. Real tenant evaluation and the normal release gates are still required.
