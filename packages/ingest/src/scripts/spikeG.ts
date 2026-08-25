/**
 * Spike G (tao-analytics-plan.md §4.2) — run once, before writing any chain
 * code. Answers three questions that gate Phase 2, not Phase 0/1:
 *
 *   1. Does Blockmachine's archive reach TAO genesis (block 1, Jan 2023)?
 *   2. Is genesis-era runtime metadata v14+ (self-describing, no hand-written
 *      type registries needed)?
 *   3. What does indexing ~1,000 blocks actually cost in RU? (read the
 *      number off the Blockmachine dashboard after this script finishes —
 *      RU accounting isn't exposed over RPC, so it can't be read back here)
 *
 * Requires BLOCKMACHINE_API_KEY. Not run as part of `pnpm test` or Phase 0/1
 * — this hits a real paid-tier endpoint.
 */

const RPC_URL = "https://rpc.blockmachine.io";
const GENESIS_BLOCK_NUMBER = 1;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

async function rpcCall<T>(apiKey: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) {
    throw new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return body.result;
}

/** SCALE metadata is [magic: 4 bytes 'meta'][version: 1 byte][...]. No SCALE
 * decoder needed for just the version — it's a fixed-offset raw byte. */
function parseMetadataVersion(hexMetadata: string): number {
  const bytes = Buffer.from(hexMetadata.replace(/^0x/, ""), "hex");
  const magic = bytes.subarray(0, 4).toString("ascii");
  if (magic !== "meta") {
    throw new Error(`Unexpected metadata magic bytes: ${magic}`);
  }
  return bytes[4]!;
}

async function main(): Promise<void> {
  const apiKey = process.env.BLOCKMACHINE_API_KEY;
  if (!apiKey) {
    console.error("BLOCKMACHINE_API_KEY is not set. Spike G cannot run — see .env.example.");
    process.exitCode = 1;
    return;
  }

  console.log(`--- Spike G: check 1 — archive depth at block ${GENESIS_BLOCK_NUMBER} ---`);
  const genesisHash = await rpcCall<string>(apiKey, "chain_getBlockHash", [GENESIS_BLOCK_NUMBER]);
  console.log(`chain_getBlockHash(${GENESIS_BLOCK_NUMBER}) = ${genesisHash}`);

  const eventsKey = "0x" + "26aa394eea5630e07c48ae0c9558cef7" + "80d41e5e16056765bc8461851072c9d7"; // twox128("System") ++ twox128("Events")
  const eventsStorage = await rpcCall<string | null>(apiKey, "state_getStorage", [eventsKey, genesisHash]);
  console.log(
    eventsStorage
      ? `state_getStorage at genesis succeeded (${eventsStorage.length} hex chars) — archive reaches genesis. PASS.`
      : `state_getStorage at genesis returned null — no events in block 1 (plausible) or archive gap. Verify manually.`,
  );

  console.log(`\n--- Spike G: check 2 — metadata version at genesis ---`);
  const metadataHex = await rpcCall<string>(apiKey, "state_getMetadata", [genesisHash]);
  const version = parseMetadataVersion(metadataHex);
  console.log(`Metadata version at genesis: V${version} — ${version >= 14 ? "PASS (self-describing)" : "FAIL (needs hand-written type registry)"}`);

  console.log(`\n--- Spike G: check 3 — RU cost of indexing ~1,000 blocks ---`);
  const startBlock = GENESIS_BLOCK_NUMBER;
  const blockCount = 1000;
  const startedAt = Date.now();
  for (let n = startBlock; n < startBlock + blockCount; n++) {
    const hash = await rpcCall<string>(apiKey, "chain_getBlockHash", [n]);
    await rpcCall<string | null>(apiKey, "state_getStorage", [eventsKey, hash]);
    if ((n - startBlock) % 100 === 0) {
      console.log(`  ...${n - startBlock}/${blockCount}`);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  console.log(`Indexed ${blockCount} blocks (${blockCount * 2} RPC calls) in ${(elapsedMs / 1000).toFixed(1)}s.`);
  console.log("Read the RU total for this window off the Blockmachine dashboard and write it into §4.2.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
