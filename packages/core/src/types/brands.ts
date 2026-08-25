/**
 * Branded primitives. See tao-analytics-plan.md §3 — these exist to make two
 * classes of bug unrepresentable at compile time: coldkey/hotkey conflation,
 * and on-chain amounts silently truncating through `number`.
 *
 * This file (plus the sibling `asX` constructors below) is the only place a
 * raw string/number/bigint is cast into a branded type. Everywhere else
 * takes and returns the branded type.
 */

declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

/** SS58 address of a coldkey. Never store this under a column named `address`. */
export type Coldkey = Brand<string, "Coldkey">;
/** SS58 address of a hotkey. Never store this under a column named `address`. */
export type Hotkey = Brand<string, "Hotkey">;

/** Integer amount in rao (1 TAO = 1e9 rao), chain-native. Always a bigint. */
export type Rao = Brand<bigint, "Rao">;
/** Decimal amount in TAO. Display only — never accumulate in this type. */
export type Tao = Brand<number, "Tao">;

export type BlockNumber = Brand<number, "BlockNumber">;
export type UnixMillis = Brand<number, "UnixMillis">;
export type SpecVersion = Brand<number, "SpecVersion">;
/** USD amount in integer cents. Avoids float drift in price/volume math. */
export type UsdCents = Brand<number, "UsdCents">;

export const RAO_PER_TAO = 1_000_000_000n;

export function asColdkey(s: string): Coldkey {
  return s as Coldkey;
}

export function asHotkey(s: string): Hotkey {
  return s as Hotkey;
}

export function asRao(v: bigint): Rao {
  return v as Rao;
}

/** Conversion happens at exactly one place: the gold export boundary (§3). */
export function raoToTao(v: Rao): Tao {
  return (Number(v) / Number(RAO_PER_TAO)) as Tao;
}

export function asBlockNumber(n: number): BlockNumber {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`BlockNumber must be a non-negative integer, got ${n}`);
  }
  return n as BlockNumber;
}

export function asUnixMillis(n: number): UnixMillis {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`UnixMillis must be a non-negative integer, got ${n}`);
  }
  return n as UnixMillis;
}

export function asSpecVersion(n: number): SpecVersion {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`SpecVersion must be a non-negative integer, got ${n}`);
  }
  return n as SpecVersion;
}

export function asUsdCents(n: number): UsdCents {
  if (!Number.isInteger(n)) {
    throw new RangeError(`UsdCents must be an integer, got ${n}`);
  }
  return n as UsdCents;
}
