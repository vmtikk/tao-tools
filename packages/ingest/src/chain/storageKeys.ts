import { blake2AsU8a, decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, u8aConcat } from "@polkadot/util";

/**
 * Fixed storage keys, precomputed once (`twox128(module) ++ twox128(item)`,
 * the standard Substrate storage-key scheme) rather than hashed at runtime —
 * matches the pattern spikeG.ts already established for `SYSTEM_EVENTS_KEY`.
 * Recomputed and verified against that script's hardcoded value in this
 * module's test.
 */
export const SYSTEM_EVENTS_KEY = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
export const TIMESTAMP_NOW_KEY = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
export const SYSTEM_ACCOUNT_PREFIX = "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";

/**
 * `System.Account` is a `blake2_128Concat`-hashed map, so unlike the two
 * constants above its key depends on the account being looked up: prefix ++
 * blake2_128(accountId bytes) ++ accountId bytes (the "Concat" hashers append
 * the un-hashed key so storage can be iterated by key, not just looked up).
 */
export function systemAccountKey(ss58Address: string): string {
  const accountId = decodeAddress(ss58Address);
  const hash = blake2AsU8a(accountId, 128);
  return u8aToHex(u8aConcat(hexToU8a(SYSTEM_ACCOUNT_PREFIX), hash, accountId));
}

/** Inverse of {@link systemAccountKey}: the trailing 32 bytes are the raw account id. */
export function coldkeyFromSystemAccountKey(storageKey: string): string {
  const bytes = hexToU8a(storageKey);
  if (bytes.length !== 32 + 16 + 32) throw new Error(`Not a System.Account key: ${storageKey}`);
  return encodeAddress(bytes.subarray(48), 42);
}

function hexToU8a(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
