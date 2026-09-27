const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PALLET_ACCOUNT_MAGIC = [0x6d, 0x6f, 0x64, 0x6c]; // "modl"

function base58Decode(input: string): Uint8Array | null {
  let value = 0n;
  for (const ch of input) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const ch of input) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/**
 * Returns the 8-byte pallet id (e.g. "subtensr") if `ss58` is a
 * pallet-derived account — Substrate's `PalletId::into_account` /
 * `into_sub_account`, laid out as "modl" ++ pallet id ++ optional
 * sub-account encoding ++ zero padding — or null for an ordinary account.
 *
 * These are runtime-controlled accounts, not users: since subtensor runtime
 * 411 (block 8,283,784) per-subnet `subtensr` sub-accounts sweep into the
 * main one ~200 times a block, which is why transfer counts need to tell
 * them apart. Checksum isn't verified — inputs come from our own decoder.
 */
export function palletIdOf(ss58: string): string | null {
  const bytes = base58Decode(ss58);
  if (!bytes || bytes.length < 35) return null;
  // SS58 network prefix is 1 byte for ids < 64, else 2; then 32-byte account id, then checksum.
  const prefixLength = bytes[0]! < 64 ? 1 : 2;
  const account = bytes.subarray(prefixLength, prefixLength + 32);
  if (account.length !== 32) return null;
  for (let i = 0; i < PALLET_ACCOUNT_MAGIC.length; i++) {
    if (account[i] !== PALLET_ACCOUNT_MAGIC[i]) return null;
  }
  return String.fromCharCode(...account.subarray(4, 12));
}
