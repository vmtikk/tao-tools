import { asColdkey, asHotkey, asRao } from "../types/brands.js";
import type { BalanceEvent, StakeEvent } from "../types/chain.js";
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
 * (any non-`balances` section, and `balances` methods other than the four
 * listed below — e.g. `Reserved`/`Unreserved`/`Slashed` are not part of the
 * Phase 2.1/2.2 tracer bullet).
 *
 * `DustLost` normalizes to a `withdraw`, not a distinct `BalanceEvent` kind.
 * Found for real (2026-09-11, reconciling blocks 1-10,000 against live chain
 * data): the runtime reaps an account once a mutation drops its free balance
 * below the existential deposit, emitting `DustLost { account, amount }` for
 * the exact remaining balance it sweeps — same `(who, amount)` shape as
 * `Withdraw`, and debiting that amount is exactly what reaping does to the
 * fold's own balance map. Without this, an account that gets reaped keeps a
 * phantom leftover balance in the fold forever (confirmed against a real
 * account: baseline 9,999,712 rao, a 143-rao fee withdraw, a 9,999,568-rao
 * transfer out, and a `DustLost` of the exact 1-rao remainder — the fold
 * without `DustLost` reconstructs balance 1; the real on-chain balance is 0).
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
    case "Withdraw":
    case "DustLost": {
      const [coldkey, amount] = evt.data as [string, bigint];
      return { kind: "withdraw", blockNumber, eventIndex, coldkey: asColdkey(coldkey), amount: asRao(amount) };
    }
    default:
      return null;
  }
}

/**
 * Normalizes a decoded pre-dTAO `SubtensorModule::StakeAdded`/`StakeRemoved`
 * into a {@link StakeEvent}. See `types/chain.ts`'s `StakeAddedEvent` doc
 * comment for why this is hotkey-keyed, not coldkey-keyed. Returns null for
 * any other section/method, including the dTAO-era 6-field shape — the
 * decode layer (`decodeEvents.ts`) is what filters that out by field count,
 * this is just the second line of defense against a malformed 2-element
 * `data` slipping through.
 */
export function normalizeStakeEvent(
  evt: DecodedEvent,
  blockNumber: BlockNumber,
  eventIndex: number,
): StakeEvent | null {
  if (evt.section !== "subtensormodule") return null;

  switch (evt.method) {
    case "StakeAdded": {
      const [hotkey, amount] = evt.data as [string, bigint];
      return { kind: "stakeAdded", blockNumber, eventIndex, hotkey: asHotkey(hotkey), amount: asRao(amount) };
    }
    case "StakeRemoved": {
      const [hotkey, amount] = evt.data as [string, bigint];
      return { kind: "stakeRemoved", blockNumber, eventIndex, hotkey: asHotkey(hotkey), amount: asRao(amount) };
    }
    default:
      return null;
  }
}
