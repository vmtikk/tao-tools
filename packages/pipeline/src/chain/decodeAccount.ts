import type { TypeRegistry } from "@polkadot/types";
import { hexToU8a } from "@polkadot/util";

export interface AccountBalances {
  free: bigint;
  reserved: bigint;
}

const accountTypeByRegistry = new WeakMap<TypeRegistry, string>();

/**
 * The `System.Account` storage value type as this runtime's metadata defines
 * it. Not polkadot.js's built-in `AccountInfo`: that assumes 128-bit
 * balances, while Bittensor's are 64-bit, so the built-in reads `free` as
 * free + reserved * 2^64 — right only when reserved is 0. Found for real
 * 2026-09-28: a coldkey with 1 TAO reserved came back as ~1.8e28 rao.
 */
export function accountInfoType(registry: TypeRegistry): string {
  const cached = accountTypeByRegistry.get(registry);
  if (cached) return cached;
  const system = registry.metadata.pallets.find((p) => p.name.toString() === "System");
  const account = system?.storage.unwrap().items.find((item) => item.name.toString() === "Account");
  if (!account) throw new Error("Runtime metadata has no System.Account storage entry");
  const typeName = registry.createLookupType(account.type.asMap.value);
  accountTypeByRegistry.set(registry, typeName);
  return typeName;
}

/**
 * `System.Account` has `modifier: Default` (tao-analytics-plan.md's
 * reconciliation needs this, §6 Phase 2.2) — an account that has never been
 * touched simply isn't in storage, and `state_getStorage` returns null for
 * it. The runtime treats that as the all-zero `AccountInfo` fallback, not an
 * error, so this does the same rather than requiring every reconciled
 * coldkey to already have a storage entry.
 */
export function decodeAccountBalances(registry: TypeRegistry, accountInfoHex: string | null): AccountBalances {
  if (!accountInfoHex) return { free: 0n, reserved: 0n };
  const info = registry.createType(accountInfoType(registry), hexToU8a(accountInfoHex)) as unknown as {
    data: { free: { toBigInt(): bigint }; reserved: { toBigInt(): bigint } };
  };
  return { free: info.data.free.toBigInt(), reserved: info.data.reserved.toBigInt() };
}
