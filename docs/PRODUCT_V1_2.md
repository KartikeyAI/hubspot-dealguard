# DealGuard v1.2 product definition

## Release objective

v1.2 makes DealGuard readiness data usable throughout HubSpot without requiring users to remain inside the DealGuard card or settings view. The deterministic assessment remains the source of truth; native properties and workflow outputs are distribution surfaces for that result.

## Native deal properties

DealGuard provisions exactly seven fields:

| Property | Purpose |
|---|---|
| `dealguard_readiness_score` | Latest score from 0 to 100 |
| `dealguard_readiness_status` | `ready`, `at_risk`, or `critical` |
| `dealguard_readiness_grade` | Latest A–F grade |
| `dealguard_issue_count` | Number of current readiness issues |
| `dealguard_handoff_status` | `not_applicable`, `required`, or `confirmed` |
| `dealguard_last_assessed_at` | Latest assessment timestamp |
| `dealguard_readiness_summary` | Optional human-readable summary |

These fields support HubSpot lists, saved views, reports, workflow branches, and downstream integrations that consume deal properties.

## Governance model

- Native sync is available only on Growth and beta-Growth.
- It is disabled by default.
- A HubSpot administrator must provision the fields and then explicitly enable writes.
- The CRM adapter enforces a fixed seven-field allowlist.
- Existing fields with incompatible types or enumeration options block provisioning.
- DealGuard never writes to non-DealGuard deal properties.
- Portal scans use HubSpot batch updates capped at 100 records per request.
- Individual record, webhook, and workflow assessments update one deal at a time.

## Workflow outputs

The **Assess deal with DealGuard** action returns:

- readiness score;
- readiness status;
- readiness grade;
- issue count;
- handoff status;
- readiness summary;
- assessment timestamp.

The outputs can be used by later workflow branches and actions independently of native property write-back.

## Upgrade behaviour

v1.2 adds deal and deal-schema write scopes. Existing installations must reauthorize before property provisioning. Upgrading does not automatically create properties, enable sync, or backfill records.

## Data ownership

Deleting Rokad-hosted DealGuard data removes the installation, assessments, settings, integration credentials, and operational records from DealGuard infrastructure. Values and property definitions already stored in HubSpot remain customer-controlled CRM data. DealGuard does not erase them automatically.

## Non-goals

- Writing to customer-owned fields.
- Automatically changing deal stage, owner, amount, close date, or forecast category.
- Predictive win probability.
- Autonomous remediation.
- Creating reports or lists on the customer's behalf.
- Deleting HubSpot property definitions during app-data deletion.
