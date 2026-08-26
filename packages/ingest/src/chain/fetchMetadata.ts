import type { BlockmachineClient } from "./rpcClient.js";

export interface ChainMetadata {
  specVersion: number;
  metadataHex: string;
}

interface RuntimeVersion {
  specVersion: number;
}

/** Fetches runtime metadata at a given block hash — 2 RPC calls, meant to be
 * called once per ingestion run, not per block (see bronzeWriter.ts's note on
 * `specVersion` being assumed constant across a short range). */
export async function fetchRuntimeMetadata(client: BlockmachineClient, blockHash: string): Promise<ChainMetadata> {
  const runtimeVersion = await client.call<RuntimeVersion>("state_getRuntimeVersion", [blockHash]);
  const metadataHex = await client.call<string>("state_getMetadata", [blockHash]);
  return { specVersion: runtimeVersion.specVersion, metadataHex };
}
