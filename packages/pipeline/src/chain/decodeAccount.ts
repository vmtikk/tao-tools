import type { TypeRegistry } from "@polkadot/types";
import { hexToU8a } from "@polkadot/util";

/**
 * `System.Account` has `modifier: Default` (tao-analytics-plan.md's
 * reconciliation needs this, §6 Phase 2.2) — an account that has never been
 * touched simply isn't in storage, and `state_getStorage` returns null for
 * it. The runtime treats that as the all-zero `AccountInfo` fallback, not an
 * error, so this does the same rather than requiring every reconciled
 * coldkey to already have a storage entry.
 */
export function decodeFreeBalance(registry: TypeRegistry, accountInfoHex: string | null): bigint {
  if (!accountInfoHex) return 0n;
  const info = registry.createType("AccountInfo", hexToU8a(accountInfoHex)) as unknown as {
    data: { free: { toBigInt(): bigint } };
  };
  return info.data.free.toBigInt();
}
