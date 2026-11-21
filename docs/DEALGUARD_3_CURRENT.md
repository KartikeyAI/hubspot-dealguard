# DealGuard v3: current release candidate

Updated November 21, 2026. Canonical product version: **3.0.0-rc.1**.

This source integrates the previously separate intelligence candidate with the
published PR #47 production-hardening base and the remaining engineering work.
It is a release candidate for independent Codex review and staging acceptance,
**not a signed production approval or a deployment receipt**. Use the actual
checkout SHA/tree and matching CI run as source identity. Earlier 581-, 670- and
727-test reports refer to different source checkpoints.

## Implemented v3 scope

| Area | Current behavior | Evidence boundary |
| --- | --- | --- |
| Deterministic intelligence | Recorded readiness and Deal Brief, separate source clocks, explicit refresh, current role and record scope | Opening a card does not contact HubSpot or create work. Missing/stale evidence remains unavailable. |
| Closed-loop remediation | Revision/source-fenced cases, recommendations, automatic resolution, atomic audit/event/outbox writes and task intent | Uncertain task delivery is held for reconciliation, not blindly retried. |
| Outcome evaluation | Explicit consent, immutable tenant-bound datasets, time-separated splits and durable bounded evaluation jobs | Recorded quarter-end outcomes are observational. Missing labels are excluded. |
| Qualified forecasting | Versioned artifacts, distinct assigned reviewer, evidence digest, quarter-anchor inference, monitoring, expiry and kill switches | Default off. Every probability requires current consent, entitlement, cohort support and monitoring. No real customer model is pre-approved. |
| Native AI | Risk review, manager questions, next actions and current closed-won handover; scoped facts, encrypted cache and atomic budgets | Generated prose is limited to review questions/requests. Live model quality/privacy/cost evaluation and human review remain required. |
| Handover lifecycle | Current closed-won cycle and confirmation revision bound into AI admission, settlement and cache | Reopening/re-winning invalidates prior drafts. External delivery assignments and document verification remain explicitly unavailable. |
| Optional Breeze | Five separately consented read-only adapters with action-ID binding, callback admission and budgets | Components remain outside the canonical project until applicable approval and account acceptance. |
| Installation and permissions | Active-grant rechecks, atomic refresh compare-and-swap, stale callback fencing and authoritative scoped roles | Transient OAuth failures do not revoke consent. Older callbacks cannot overwrite a later disconnect/reinstall. |
| Commercial access | One request-time entitlement decision across access, plans, allowances, provider updates and scheduled changes | Recorded expiry boundaries deny paid features immediately. Compatible open-ended contracts are documented explicitly. |
| Home and setup | Billing-only access, independent panels, actual permission gates, explicit assessment and governed role administration | Two signed identities establish the initial administrator pair. Later role changes require a distinct reviewer and exact approved replay. |
| Approval integrity | Tenant-locked requests/decisions, reviewed target-state binding, current requester/reviewer rechecks, atomic role/audit/completion and execution lease tokens | Stale, expired, altered or unauthorized approvals cannot apply. Legacy direct role writes are retired. |
| Data erasure | Durable epoch-bound intent, bounded leased maintenance retries, hold checks between storage calls and final prefix sweep after old upload links expire | Accepted work returns pending status. Completion requires actual object cleanup and transactional tenant erasure with a minimal hashed receipt. |
| Release controls | Locked dependencies, isolated PostgreSQL runner, current schema validation, synchronized versions and protected workflows | Prereleases remain rejected by stable production sign-off. Tests cannot create live approval evidence. |

The scope is DealGuard v3. Broader lead-management, customer-success, theme and ERP
products from the Rokad strategy are separate work. DealGuard remains useful
without AI and without mandatory professional services.

## Validation and source custody

Follow `CODEX_V3_VALIDATION.md` for a clean checkout, dependency installation,
disposable PostgreSQL, Worker/UI checks, full regressions and review priorities.
Canonical CI also renders and bundles a non-secret staging Worker configuration
without publishing it. Previously published migrations `0001`–`0030` remain
unchanged. Recovered migrations `0031`–`0035` are integrated; later migrations add
forecast, remediation, handover, billing, OAuth, resumable deletion, paired administrator setup and atomic change-approval protection through `0043`.
Checksum validation verifies the complete sequence before release operations.

Local tests use synthetic records and simulated provider responses where needed.
Pass counts, runtime versions and source fingerprints belong in the exact
validation receipt. GitHub results belong to the matching immutable commit/run.
A local encrypted restore rehearsal is not evidence of Neon/Tigris recovery or
production RPO/RTO. No local fixture is represented as a real independent review.

## Remaining production evidence

The approval contract in `STABLE_3_0_SIGNOFF.md` remains in force. Production
requires protected environment and repository governance; actual HubSpot build,
install, persona and upgrade acceptance; supported Dodo lifecycle acceptance;
independent security review and live native-AI evaluation; representative
10,000-deal/two-portal load and queue recovery; provider database/object restore
with measured RPO/RTO; three consenting pilots; operating ownership; and the
signed eleven-category dossier for the exact stable candidate. Breeze stays
excluded until approved; unqualified forecasts stay disabled.

GitHub issues #38, #41 and #42 were still open when inspected on November 21, 2026.
Public main reported protection disabled and no repository rulesets. Protected
environment values were not exposed by the connected read endpoint, so their
current contents must not be inferred from historical issue descriptions.

Controlled production deployment and post-deployment observation follow actual
independent approval. A version bump, green code test or source merge cannot
supply missing provider, pilot or operating evidence.
