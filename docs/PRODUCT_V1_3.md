# DealGuard v1.3 product definition

## Release objective

v1.3 changes DealGuard from a configurable RevOps utility into a governed enterprise control plane. It introduces a formal policy lifecycle, role-aware administration, two-person approval, executive pipeline exposure, simulation, rollback, and audit export while preserving deterministic scoring as the source of truth.

## Enterprise App Home

The HubSpot App Home provides:

- current readiness score and critical-deal count;
- total pipeline amount at risk;
- incomplete closed-won handoffs;
- policies awaiting approval;
- active policy identity and publisher;
- latest policy-simulation result;
- risk breakdown by pipeline and owner;
- policy lifecycle actions and draft editing.

## Governance roles

| Role | Primary responsibilities |
|---|---|
| Administrator | Enable governance, manage roles, approve/publish policies, export audit history |
| Policy administrator | Draft, edit, submit, simulate, and publish approved policies |
| Approver | Review and approve or reject submitted policies |
| Manager | View enterprise analytics, simulations, and audit history |
| Viewer | Read-only enterprise access |

The installing HubSpot administrator receives bootstrap administrator authority until explicit role assignments are configured.

## Policy lifecycle

1. Enabling governance captures the current scoring configuration as baseline policy v1.
2. New revisions are created as drafts from the active or historical policy.
3. Drafts can be edited without affecting live scoring.
4. Submitted drafts enter `pending_approval`.
5. An independent approver approves or rejects the revision.
6. Approved policies can be published by an authorised administrator.
7. Publication supersedes the previous policy and atomically updates live scoring rules.
8. Historical policies can produce rollback drafts; published history is never mutated.

When self-approval prevention is enabled, a policy creator cannot approve their own revision.

## Simulation

Policy simulation evaluates a draft against up to 1,000 current deals and returns:

- number of affected deals;
- projected ready, at-risk, and critical counts;
- current versus projected average readiness score;
- execution status and error state.

Simulation does not update deals, active policy, native properties, or notifications.

## Enterprise analytics

Each completed scan captures a daily snapshot containing:

- total open deals;
- ready, at-risk, and critical deals;
- average readiness score;
- total open-pipeline amount;
- pipeline amount at risk;
- incomplete handoffs;
- active policy identifier.

Assessment context stores only deal amount, HubSpot owner ID, pipeline ID, and stage ID alongside the derived assessment. Contact and company records remain unpersisted.

## Governed settings

After governance is enabled:

- general settings cannot disable governance;
- general settings cannot change scoring rules;
- Slack, digest, and native-sync settings remain independently editable;
- scoring changes require a versioned policy publication.

## Auditability

Enterprise users with appropriate permissions can search audit events and export up to 10,000 events as CSV. Policy creation, edits, submissions, decisions, publication, role assignment, governance enablement, scans, and integration activity remain actor-attributed.

## Non-goals

- Predictive scoring or win probability.
- Autonomous changes to deal owner, stage, amount, close date, or forecast category.
- Enterprise billing and contract administration; these belong to v1.4.
- AI-generated recommendations and benchmarking; these belong to v1.5.
