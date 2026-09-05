# Future work

Deferred decisions and possible improvements that are deliberately **not** on the critical path.
Nothing here blocks anything in `tao-analytics-plan.md` — that's the point of writing it down here
instead of just deciding in the moment. Add an entry whenever a "we could do X later" comes up instead
of letting it get lost in chat history. Mark an item done (strike it or move it to a "Resolved"
section with the date) once it's actually acted on.

## Open items

- **Taobridge as its own series** (added 2026-09-05) — Taostats' `/api/exchange/v1` labels coldkey
  `5HiveMEoWPmQmBAb8v63bKPcFhgTGCmST1TVZNvPHSTKFLCv` as "Taobridge". It's a cross-chain bridge, not a
  centralized exchange, so it's excluded from `data/meta/exchange_labels.json` and the "TAO on
  exchanges" chart (§7.2) doesn't include it. Possible future addition: a separate "TAO locked in
  bridges" series, if that becomes interesting — the coldkey is already known, so this is cheap
  whenever it's wanted.

- **Exchange label confidence is Taostats-only** (added 2026-09-05) — all 10 entries in
  `data/meta/exchange_labels.json` are `confidence: "medium"`, sourced only from Taostats' own
  tagging. §7.2's other two sourcing steps (cross-referencing a published proof-of-reserves; a
  personal deposit-and-observe test) haven't been done for any of them. Decision: trust Taostats as
  sufficient for now rather than block chart 3.3 on independent verification. Revisit if the exchange
  balances chart needs to support a real financial claim (rather than a rough "TAO held by known
  exchanges" estimate) — at that point, upgrading specific coldkeys to `confidence: "high"` via
  proof-of-reserves cross-referencing or a real deposit test would be the way to do it, one coldkey at
  a time, without needing to touch the pipeline code.
