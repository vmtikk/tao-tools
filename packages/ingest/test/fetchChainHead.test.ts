import { describe, expect, it } from "vitest";
import type { BlockmachineClient } from "../src/chain/rpcClient.js";
import { fetchChainHead } from "../src/chain/fetchChainHead.js";

function fakeClient(headerNumberHex: string): BlockmachineClient {
  return {
    requestCount: 1,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === "chain_getHeader" && params.length === 0) {
        return { number: headerNumberHex } as T;
      }
      throw new Error(`unexpected call ${method}(${JSON.stringify(params)})`);
    },
  };
}

describe("fetchChainHead", () => {
  it("parses the hex block number from chain_getHeader", async () => {
    const client = fakeClient("0x2b3a01");
    await expect(fetchChainHead(client)).resolves.toBe(parseInt("2b3a01", 16));
  });

  it("calls chain_getHeader with no arguments", async () => {
    const client = fakeClient("0x1");
    await expect(fetchChainHead(client)).resolves.toBe(1);
  });
});
