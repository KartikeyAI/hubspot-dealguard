# DealGuard backend API

All `/api/v1/*` calls are intended for HubSpot UI extensions and require a valid HubSpot request signature. HubSpot adds `portalId`, `userId`, `userEmail`, and `appId` query metadata. Responses are JSON and are never cached.

## Portal endpoints

- `GET /api/v1/dashboard` — current pipeline-health totals, frequent gaps, high-priority deals, and latest scan status.
- `GET /api/v1/metadata` — readable deal properties plus pipeline and stage metadata used by the rule editor.
- `GET /api/v1/settings` — current plan and normalized portal settings.
- `PUT /api/v1/settings` — replace and validate portal settings; plan limits are enforced server-side.
- `POST /api/v1/scans` — queue a background portal scan and return `202` with a scan ID.
- `POST /api/v1/digest/test` — send a test digest to configured recipients.
- `DELETE /api/v1/data` — destroy DealGuard-derived data and stored credentials; requires the exact confirmation phrase.

## Deal endpoints

- `GET /api/v1/deals/:id/assessment` — return a recent cached assessment or recompute it.
- `POST /api/v1/deals/:id/assessment` — force an on-demand assessment.
- `POST /api/v1/deals/:id/review` — mark the current findings reviewed.
- `POST /api/v1/deals/:id/handoff` — confirm a non-critical closed-won handoff.

## Operator endpoint

- `PUT /internal/portals/:portalId/plan` — change portal entitlement using `Authorization: Bearer $ADMIN_API_KEY`.

## Public endpoints

- `GET /health`
- `GET /docs`
- `GET /privacy`
- `GET /terms`
- `GET /support`
- `GET /oauth/install`
- `GET /oauth/callback`
