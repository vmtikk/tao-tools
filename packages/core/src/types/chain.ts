import type { BlockNumber, Coldkey, Rao } from "./brands.js";

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
