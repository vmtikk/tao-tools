import { asRao } from "../types/brands.js";
import type { Coldkey, Rao } from "../types/brands.js";
import type { BalanceEvent } from "../types/chain.js";

/** Free-balance-in-rao per coldkey. Never keyed by a bare `address` (§3, §7.1). */
export type BalanceMap = ReadonlyMap<Coldkey, Rao>;

const ZERO = asRao(0n);

function credit(balances: BalanceMap, coldkey: Coldkey, amount: Rao): BalanceMap {
  const next = new Map(balances);
  next.set(coldkey, asRao((next.get(coldkey) ?? ZERO) + amount));
  return next;
}

function debit(balances: BalanceMap, coldkey: Coldkey, amount: Rao): BalanceMap {
  const next = new Map(balances);
  next.set(coldkey, asRao((next.get(coldkey) ?? ZERO) - amount));
  return next;
}

/**
 * Applies one balance-affecting event to a balance map, returning a new map
 * (tao-analytics-plan.md §5 Tier 1: "Balance reconstruction fold —
 * `(BalanceMap, Event[]) => BalanceMap`. A pure reducer, and the single
 * highest-value test target in the project.").
 *
 * `deposit`/`withdraw` change total supply (block-reward emission, fees);
 * `transfer` does not. This is the reducer §7.1 means when it says wallet
 * counts must come from folding the event index rather than snapshotting
 * `System.Account` per day.
 */
export function applyBalanceEvent(balances: BalanceMap, event: BalanceEvent): BalanceMap {
  switch (event.kind) {
    case "transfer":
      return credit(debit(balances, event.from, event.amount), event.to, event.amount);
    case "deposit":
      return credit(balances, event.coldkey, event.amount);
    case "withdraw":
      return debit(balances, event.coldkey, event.amount);
  }
}

/**
 * Folds a full event list into a balance map. Caller supplies events already
 * ordered by (blockNumber, eventIndex) — this function doesn't sort, so an
 * out-of-order input silently produces an out-of-order-correct result (the
 * fold is associative for whichever order it's given; getting the *right*
 * order is the caller's job, not this function's).
 */
export function reconstructBalances(
  events: readonly BalanceEvent[],
  initial: BalanceMap = new Map(),
): BalanceMap {
  return events.reduce(applyBalanceEvent, initial);
}
