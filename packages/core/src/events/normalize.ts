import { asColdkey, asRao } from "../types/brands.js";
import type { BalanceEvent } from "../types/chain.js";
import type { BlockNumber } from "../types/brands.js";

/**
 * An already-SCALE-decoded event, expressed as plain data — no `@polkadot/*`
 * type leaks past this boundary (tao-analytics-plan.md §3 dependency rule).
 * The pipeline package owns turning raw bronze hex + metadata into this shape
 * (impure: needs a `TypeRegistry`); this module owns turning *that* into a
 * typed domain object (pure, tao-analytics-plan.md §5 Tier 1: "Event -> row
 * normalization").
 */
export interface DecodedEvent {
  section: string;
  method: string;
  /** Field values in declaration order, already unwrapped to plain JS —
   * addresses as SS58 strings, amounts as `bigint`. */
  data: readonly unknown[];
}

/**
 * Normalizes a decoded `pallet_balances` event into a {@link BalanceEvent}.
 * Returns null for every event this pipeline doesn't fold into balances yet
 * (any non-`balances` section, and `balances` methods other than the three
 * listed below — e.g. `Reserved`/`Unreserved`/`Slashed` are not part of the
 * Phase 2.1/2.2 tracer bullet).
 */
export function normalizeBalanceEvent(
  evt: DecodedEvent,
  blockNumber: BlockNumber,
  eventIndex: number,
): BalanceEvent | null {
  if (evt.section !== "balances") return null;

  switch (evt.method) {
    case "Transfer": {
      const [from, to, amount] = evt.data as [string, string, bigint];
      return {
        kind: "transfer",
        blockNumber,
        eventIndex,
        from: asColdkey(from),
        to: asColdkey(to),
        amount: asRao(amount),
      };
    }
    case "Deposit": {
      const [coldkey, amount] = evt.data as [string, bigint];
      return { kind: "deposit", blockNumber, eventIndex, coldkey: asColdkey(coldkey), amount: asRao(amount) };
    }
    case "Withdraw": {
      const [coldkey, amount] = evt.data as [string, bigint];
      return { kind: "withdraw", blockNumber, eventIndex, coldkey: asColdkey(coldkey), amount: asRao(amount) };
    }
    default:
      return null;
  }
}
