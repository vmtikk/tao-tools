import type { BlockmachineClient } from "./rpcClient.js";

export interface RuntimeSegment {
  /** Inclusive. */
  fromBlock: number;
  /** Inclusive. */
  toBlock: number;
  specVersion: number;
}

interface RuntimeVersionResult {
  specVersion: number;
}

async function specVersionAt(client: BlockmachineClient, blockNumber: number): Promise<number> {
  const hash = await client.call<string>("chain_getBlockHash", [blockNumber]);
  const { specVersion } = await client.call<RuntimeVersionResult>("state_getRuntimeVersion", [hash]);
  return specVersion;
}

interface Breakpoint {
  /** First block of the new spec_version. */
  block: number;
  specVersion: number;
}

/**
 * Finds every block within (from, to] where spec_version changes, using
 * divide-and-conquer rather than checking every block (tao-analytics-plan.md
 * §6, Phase 2.3 prerequisite: "check state_getRuntimeVersion per block (or
 * batch-detect upgrade boundaries some cheaper way)"). O(log range) RPC calls
 * per upgrade found, instead of O(range).
 *
 * Correct because spec_version is monotonically non-decreasing over the block
 * sequence — a runtime upgrade never reverts. That guarantee is what makes
 * `fromSpec === toSpec => no change anywhere inside` a safe shortcut: if the
 * version dipped and came back, this would silently miss it, but Substrate
 * runtimes don't do that.
 */
async function findBreakpoints(
  client: BlockmachineClient,
  from: number,
  to: number,
  fromSpec: number,
  toSpec: number,
): Promise<Breakpoint[]> {
  if (fromSpec === toSpec) return [];
  if (to === from + 1) return [{ block: to, specVersion: toSpec }];

  const mid = from + Math.floor((to - from) / 2);
  const midSpec = await specVersionAt(client, mid);

  const left = await findBreakpoints(client, from, mid, fromSpec, midSpec);
  const right = await findBreakpoints(client, mid, to, midSpec, toSpec);
  return [...left, ...right];
}

/**
 * Splits [fromBlock, toBlock] into contiguous same-spec_version segments.
 * A range with no upgrade inside costs exactly 2 `specVersionAt` calls
 * (4 RPC calls); each upgrade found costs roughly `2*log2(range)` more.
 */
export async function detectRuntimeSegments(
  client: BlockmachineClient,
  fromBlock: number,
  toBlock: number,
): Promise<RuntimeSegment[]> {
  if (toBlock < fromBlock) {
    throw new Error(`toBlock (${toBlock}) must be >= fromBlock (${fromBlock})`);
  }

  const fromSpec = await specVersionAt(client, fromBlock);
  if (fromBlock === toBlock) {
    return [{ fromBlock, toBlock, specVersion: fromSpec }];
  }

  const toSpec = await specVersionAt(client, toBlock);
  const breakpoints = await findBreakpoints(client, fromBlock, toBlock, fromSpec, toSpec);

  const segments: RuntimeSegment[] = [];
  let segmentStart = fromBlock;
  let segmentSpec = fromSpec;
  for (const breakpoint of breakpoints) {
    segments.push({ fromBlock: segmentStart, toBlock: breakpoint.block - 1, specVersion: segmentSpec });
    segmentStart = breakpoint.block;
    segmentSpec = breakpoint.specVersion;
  }
  segments.push({ fromBlock: segmentStart, toBlock, specVersion: segmentSpec });

  return segments;
}
