# Commercial Integrity operational notes

Commercial enrichment is an optional record-view operation. Operational metrics use service name `commercial_integrity_enrichment` and report success, latency, and source coverage. The module has an independent bounded cache and per-deal in-flight request map. It does not add queue tasks, scheduled work, webhook subscriptions, persistence tables, or migration requirements.
