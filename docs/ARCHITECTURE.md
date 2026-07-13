# Architecture

## Runtime components

1. **HubSpot project (2026.03)**
   - Marketplace OAuth app.
   - Deal record app card.
   - Connected-app settings extension.

2. **Cloudflare Worker**
   - OAuth installation and token refresh.
   - Signed `hubspot.fetch()` API.
   - HubSpot CRM API adapter.
   - Deterministic scoring engine.
   - Scan orchestration and scheduled execution.
   - Digest delivery through Resend when configured.
   - Public setup, privacy, terms, and support pages.

3. **Cloudflare D1**
   - Tenant configuration and encrypted credential envelopes.
   - Current deal assessments.
   - Reviews and handoff confirmations.
   - Scan history and audit events.

## Request trust boundaries

- OAuth callbacks are protected by single-use, hashed, ten-minute state values.
- UI-extension calls must carry a valid HubSpot v3 signature. v1/v2 verification is retained for compatible HubSpot callback surfaces.
- Portal and user identity are accepted only from signature-bound HubSpot query metadata.
- Internal plan mutation requires an independent bearer secret.

## Data minimisation

DealGuard stores only deal IDs, derived readiness results, issue metadata, review and handoff state, scan aggregates, app settings, audit events, and encrypted OAuth credentials. Raw contact and company records are not persisted; only association counts are used.
