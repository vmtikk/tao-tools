import { TypeRegistry, Metadata } from "@polkadot/types";
import { hexToU8a } from "@polkadot/util";
import {
  normalizeBalanceEvent,
  normalizeStakeEvent,
  asBlockNumber,
  type BalanceEvent,
  type StakeEvent,
  type DecodedEvent,
} from "@tao-tools/core";

/**
 * Offline SCALE decoding — this is the one place `@polkadot/types` is
 * allowed (tao-analytics-plan.md §3: `core` may not import it). No network
 * call happens here; `registry.createType` decodes bytes already sitting in
 * bronze against metadata already sitting in bronze. Splitting decode
 * (impure, here) from normalize (pure, `core`) is deliberate — §5 Tier 1
 * unit-tests "decoded EventRecord -> Transfer/StakeEvent" without any of
 * this SCALE machinery in the loop.
 */

export function buildRegistry(metadataHex: string): TypeRegistry {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, metadataHex as `0x${string}`);
  registry.setMetadata(metadata);
  return registry;
}

function numericCodecToBigInt(codec: unknown): bigint {
  const c = codec as { toBigInt?: () => bigint };
  if (typeof c.toBigInt !== "function") {
    throw new Error(`Expected a numeric codec with toBigInt(), got ${String(codec)}`);
  }
  return c.toBigInt();
}

/**
 * Only `pallet_balances` `Transfer`/`Deposit`/`Withdraw` and pre-dTAO
 * `SubtensorModule` `StakeAdded`/`StakeRemoved` are extracted — every other
 * event (every other pallet, plus the dTAO-era 6-field stake shape) passes
 * through bronze untouched and gets decoded later, when a phase needs it
 * (§10: "Store the entire System.Events blob per block, unparsed hex...
 * Decode selectively at silver.").
 */
function toDecodedEvent(event: { section: string; method: string; data: unknown }): DecodedEvent | null {
  const section = event.section.toLowerCase();
  const data = event.data as ArrayLike<unknown>;

  if (section === "balances") {
    if (event.method === "Transfer") {
      const [from, to, amount] = [data[0], data[1], data[2]];
      return { section, method: "Transfer", data: [String(from), String(to), numericCodecToBigInt(amount)] };
    }
    if (event.method === "Deposit" || event.method === "Withdraw") {
      const [who, amount] = [data[0], data[1]];
      return { section, method: event.method, data: [String(who), numericCodecToBigInt(amount)] };
    }
    return null;
  }

  if (section === "subtensormodule" && (event.method === "StakeAdded" || event.method === "StakeRemoved")) {
    // Pre-dTAO shape only (2 fields: hotkey, amount). The dTAO/subnet-token
    // rewrite (spec_version 438+, discovered 2026-08-27 against real bronze)
    // widens this to 6 fields including a netuid — subnet/alpha-denominated
    // stake, out of v1's TAO-only scope (tao-analytics-plan.md §1, §13).
    // Anything that isn't the 2-field shape is left undecoded here rather
    // than guessed at.
    if (data.length !== 2) return null;
    const [hotkey, amount] = [data[0], data[1]];
    return { section, method: event.method, data: [String(hotkey), numericCodecToBigInt(amount)] };
  }

  return null;
}

export interface DecodedChainEvents {
  balanceEvents: BalanceEvent[];
  stakeEvents: StakeEvent[];
}

/**
 * Decodes one block's raw `System.Events` hex into normalized balance and
 * (pre-dTAO) stake events, in event order, in a single pass over the
 * `Vec<EventRecord>` SCALE decode — that decode is the dominant cost of
 * `chain:materialize-silver` (hours over the full backfill), so extracting
 * two event kinds must not mean decoding the same bytes twice. `eventsHex`
 * of `"0x00"` (the empty-Vec encoding ingest normalizes a null storage read
 * to) decodes to zero events of either kind.
 */
export function decodeChainEventsForBlock(registry: TypeRegistry, eventsHex: string, blockNumber: number): DecodedChainEvents {
  // Numeric codecs (u64 below) interpret a hex *string* as a literal value to
  // construct, not as SCALE bytes to decode — `createType('u64', '0x09...')`
  // silently returns the wrong number instead of throwing. `Vec<EventRecord>`
  // happens not to have that ambiguity, but converting to bytes everywhere
  // this module calls `createType` on stored hex is the only way to not
  // re-learn that the hard way per call site.
  const records = registry.createType("Vec<EventRecord>", hexToU8a(eventsHex));
  const bn = asBlockNumber(blockNumber);
  const balanceEvents: BalanceEvent[] = [];
  const stakeEvents: StakeEvent[] = [];

  let eventIndex = 0;
  for (const record of records) {
    const decoded = toDecodedEvent(
      (record as unknown as { event: { section: string; method: string; data: unknown } }).event,
    );
    if (decoded) {
      const balanceEvent = normalizeBalanceEvent(decoded, bn, eventIndex);
      if (balanceEvent) balanceEvents.push(balanceEvent);
      const stakeEvent = normalizeStakeEvent(decoded, bn, eventIndex);
      if (stakeEvent) stakeEvents.push(stakeEvent);
    }
    eventIndex++;
  }
  return { balanceEvents, stakeEvents };
}

/** Decodes one block's raw `System.Events` hex into normalized balance
 * events only — a thin wrapper over {@link decodeChainEventsForBlock} kept
 * for callers (and existing tests) that only need the balances side. */
export function decodeBalanceEventsForBlock(
  registry: TypeRegistry,
  eventsHex: string,
  blockNumber: number,
): BalanceEvent[] {
  return decodeChainEventsForBlock(registry, eventsHex, blockNumber).balanceEvents;
}

/** `Timestamp.Now` is a plain (non-compact) `u64` of Unix milliseconds. */
export function decodeTimestamp(registry: TypeRegistry, timestampHex: string | null): number | null {
  if (!timestampHex) return null;
  return registry.createType("u64", hexToU8a(timestampHex)).toNumber();
}
