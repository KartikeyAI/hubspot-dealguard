# Commercial Integrity security and privacy boundary

- Optional scopes are requested only after an authorized administrator initiates commercial access.
- The Worker reads only selected quote, line-item, and deal properties.
- Association and object reads are bounded and on demand.
- Proposal documents, terms, signatures, payments, attachments, and contract content are excluded.
- Record enrichment is cached for 60 seconds and is not persisted as a customer commercial dataset.
- Failure or missing authorization degrades to the existing DealGuard result.
- Commercial signals are deterministic and auditable; they are not predictions.
