import type { BlockNumber, Coldkey, Hotkey, Rao } from "./brands.js";

/**
 * A decoded `pallet_balances::Event::Transfer`. tao-analytics-plan.md §2 lists
 * `transfers.parquet` as its own silver file — this is the row shape.
 */
export interface TransferEvent {
  kind: "transfer";
  blockNumber: BlockNumber;
  eventIndex: number;
  from: Coldkey;
  to: Coldkey;
  amount: Rao;
}

/** A decoded `pallet_balances::Event::Deposit` — credits a free balance
 * (block reward emission, fee payout, etc.) with no matching debit elsewhere. */
export interface DepositEvent {
  kind: "deposit";
  blockNumber: BlockNumber;
  eventIndex: number;
  coldkey: Coldkey;
  amount: Rao;
}

/** A decoded `pallet_balances::Event::Withdraw` — debits a free balance
 * (transaction fee, stake lock, etc.) with no matching credit elsewhere. */
export interface WithdrawEvent {
  kind: "withdraw";
  blockNumber: BlockNumber;
  eventIndex: number;
  coldkey: Coldkey;
  amount: Rao;
}

/**
 * Every event kind the balance-reconstruction fold (§7.1, §5 Tier 1) knows
 * how to apply. Deliberately just the three `pallet_balances` primitives for
 * the Phase 2.1/2.2 tracer bullet — subtensor-specific stake events are not
 * decoded yet (see reconstruct.ts's doc comment for what that means for
 * reconciliation).
 */
export type BalanceEvent = TransferEvent | DepositEvent | WithdrawEvent;

/**
 * A decoded `SubtensorModule::StakeAdded` — pre-dTAO shape only (2 fields:
 * hotkey, amount). Note this is keyed by {@link Hotkey}, not {@link Coldkey}:
 * the raw event only names the hotkey that gained stake, confirmed against
 * real bronze data (2026-08-27) by cross-referencing the account against a
 * `DelegateAdded(coldkey, hotkey, take)` event where it appears on the
 * hotkey side. Attributing stake to the coldkey that owns it needs a
 * separate hotkey->coldkey lookup (the `Owner` storage item) — this type
 * deliberately doesn't pretend to have that yet.
 */
export interface StakeAddedEvent {
  kind: "stakeAdded";
  blockNumber: BlockNumber;
  eventIndex: number;
  hotkey: Hotkey;
  amount: Rao;
}

/** A decoded `SubtensorModule::StakeRemoved` — see {@link StakeAddedEvent}. */
export interface StakeRemovedEvent {
  kind: "stakeRemoved";
  blockNumber: BlockNumber;
  eventIndex: number;
  hotkey: Hotkey;
  amount: Rao;
}

/**
 * Everything the (future) stake-reconstruction fold knows how to apply.
 * Deliberately excludes the dTAO/subnet-token era's 6-field StakeAdded/
 * StakeRemoved (spec_version 438+, netuid-bearing) — that's subnet/alpha-
 * denominated stake, out of v1 scope (tao-analytics-plan.md §1, §13).
 */
export type StakeEvent = StakeAddedEvent | StakeRemovedEvent;
