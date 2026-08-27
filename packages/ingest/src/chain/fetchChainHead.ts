import type { BlockmachineClient } from "./rpcClient.js";

interface HeaderResult {
  number: string;
}

/** Current best block number, used as the default upper bound for the Phase
 * 2.3 backfill when `TO_BLOCK` isn't pinned. `chain_getHeader` with no
 * argument returns the head header; `number` comes back as compact hex. */
export async function fetchChainHead(client: BlockmachineClient): Promise<number> {
  const header = await client.call<HeaderResult>("chain_getHeader", []);
  return parseInt(header.number, 16);
}
