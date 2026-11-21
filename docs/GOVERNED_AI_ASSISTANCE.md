# Governed native AI assistance

## Available implementation

The optional native assistant supports `risk`, `manager_review`, `next_action`
and `handover` purposes with usable recorded readiness evidence. `risk`,
`manager_review` and `next_action` require an available open deal. `handover`
requires the current recorded closed-won handoff cycle; its source, cycle and
confirmation state are bound at admission, settlement and cached reads.
Reopening, re-winning, confirmation changes and source changes invalidate the
old draft. It is a bounded review/drafting capability with mandatory human review.

The current provider adapter uses the OpenAI Responses API at a fixed origin.
It requires an explicitly configured approved exact model identifier; no model,
API key or token price is fabricated or enabled by default. The request asks for
structured JSON and sets `store: false`, `background: false`, `stream: false` and
a 1,200-token output bound. It has a 16,000-byte serialized request cap, a
64,000-byte response cap, a 12-second timeout and redirect rejection. There are
no tools, SQL execution, arbitrary URL fetching or CRM mutations in the adapter.
`store: false` must not be represented as a promise of zero provider retention;
provider processing terms still require review for the chosen account/model.

## Evidence and output

The evidence service authorizes the current recorded deal scope, checks source
age and creates a fingerprint from a curated set of facts: readiness score, issue
count, observation time, and usable deterministic risk/action codes. Customer
names, amounts, communications, custom-field text and contact payloads are not
sent by this implementation. Missing richer context is not inferred.

Handover facts include the actual cycle, readiness, pending/confirmed state,
observed start basis and relevant timestamps. External document verification and
delivery assignment are explicitly unavailable; the assistant requests review
instead of inventing them. Optional open-deal risks are not carried forward as
closed-won evidence. Manager-review changes require the immediately preceding
valid observation to be open, recent, in the same known policy version and
pipeline, and within the user's historical scope. An intervening close, policy
change or scope mismatch produces an unavailable comparison. Regenerating a
snapshot never renews the underlying source observation times.

Each returned section must use a known heading, bounded text and valid supplied
evidence IDs. Generated prose is restricted to recognized review questions and
requests, including summary and limitation sections. URLs, markup, numeric
characters, English spelled quantities/currencies and certain unsupported
predictive or handoff-completion claims are rejected. Factual numbers are rendered separately from the
deterministic evidence. These are structural output checks, **not proof of semantic
entailment or a universal hallucination prevention mechanism**. Live model quality,
prompt-injection evaluation, usefulness and human-review behavior remain release
gates. A generated recommendation does not authorize an action.

These conservative English lexical checks cannot universally exclude unsupported
meaning expressed through paraphrases, multilingual phrasing or presuppositions.
The model is not permitted to narrate new CRM facts. Original source observations
and deterministic values remain separately visible to the reviewer.

## Authorization and consent

`ai.use`, a signed stable user identity, active tenant, current record scope,
Enterprise entitlement and explicit `ai` consent are required to generate.
Portal-wide administrators manage consent and limits. Status and revocation stay
accessible to an otherwise authorized administrator after subscription expiry;
expired customers cannot generate or enable paid capabilities.

Permissions, consent revision, source identity and provider configuration are
checked around generation and before returning cached output. In-flight revocation
prevents returning the now-disallowed result. Cache entries are actor-, purpose-,
source-, model- and consent-bound and encrypted with the existing application
AES-GCM key. TTL is 15 minutes; a cache hit is not permission to bypass current
access checks. Request keys are idempotent for their exact inputs, not reusable
across different actors or sources.

## Quotas and estimated costs

Database reservations atomically enforce daily request count, per-portal
concurrency and an **estimated provider-cost budget**. Defaults are 25 requests,
two concurrent runs and USD 5 in micro-dollar accounting. The configured ranges
are bounded; changes are revision checked and audited. Before provider admission,
the worst-case token reservation uses 32,768 input tokens and 1,200 output tokens
at explicitly configured rates. Provider-reported usage is accounted when valid;
unknown failures or expired leases conservatively retain the reservation amount.
Cancellation does not assume an already admitted provider request is free.

Rate verification must be explicitly dated within the last 30 days. There are no
hard-coded current prices. This ledger is not a provider invoice, a guarantee
against a provider changing its rates, or reconciled Dodo AI-credit charging.
Unexpected usage, account-specific charges, model eligibility and invoices need
live reconciliation before a commercial cost commitment.

Request metadata is retained for seven days and daily counters for thirty days,
subject to active legal holds. Content caches expire independently. Revocation
clears eligible caches and prevents further use; held data are not exposed by
revoked access. Disconnect/deletion revokes optional consents and reinstall does
not reactivate them automatically.

## Configuration and UI

Protected Worker configuration:

- `DEALGUARD_AI_ENABLED` (default false)
- `DEALGUARD_AI_MODEL`, `DEALGUARD_AI_API_KEY`
- `DEALGUARD_AI_PRICING_VERIFIED_AT` (explicit UTC timestamp)
- `DEALGUARD_AI_INPUT_USD_PER_MILLION`, `DEALGUARD_AI_OUTPUT_USD_PER_MILLION`

Deployment preflight validates enabled configuration and renders only non-secret
values into the selected target's vars section. The API key must be provisioned
through approved Worker secret management; passing a GitHub environment value to
preflight alone does not install that secret on a Worker. Default-off flags do
not request new OAuth grants or activate third-party services.

The native `IntelligenceAssistancePanel` exposes status, explicit administrator
consent, limits, purpose/deal selection and draft sections with separate facts.
APIs are under `/api/v1/enterprise/ai`: `status`, `consent`, `limits`, `assist`.
Breeze has separate consent and read-only adapters; it does not call this provider.

## Validation status

Real PostgreSQL tests cover reservation races, retries, source/actor binding,
revocation, cancellation, budget accounting and cleanup. HTTP responses from the
provider were simulated. Worker and HubSpot SDK typechecks passed, but no live AI
provider call, rendered HubSpot acceptance, paid usage or provider privacy
certification was performed. See the complete checkpoint receipt and
`DEALGUARD_3_CURRENT.md`; do not infer production readiness from local tests.
