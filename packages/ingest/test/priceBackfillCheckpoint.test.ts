import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPriceBackfillCheckpoint,
  readPriceBackfillCheckpoint,
  venueKey,
  writePriceBackfillVenueCheckpoint,
} from "../src/prices/priceBackfillCheckpoint.js";

describe("priceBackfillCheckpoint", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-price-checkpoint-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns an empty object when no checkpoint file exists", () => {
    expect(readPriceBackfillCheckpoint()).toEqual({});
  });

  it("round-trips a written venue checkpoint", () => {
    const key = venueKey("kraken", "TAOUSD");
    writePriceBackfillVenueCheckpoint(key, 12_345);
    const checkpoint = readPriceBackfillCheckpoint();
    expect(checkpoint[key]?.lastWrittenMs).toBe(12_345);
    expect(typeof checkpoint[key]?.updatedAtMs).toBe("number");
  });

  it("keeps each venue's progress independent — one restart doesn't clobber another venue", () => {
    writePriceBackfillVenueCheckpoint(venueKey("kraken", "TAOUSD"), 100);
    writePriceBackfillVenueCheckpoint(venueKey("binance", "TAOUSDT"), 200);
    const checkpoint = readPriceBackfillCheckpoint();
    expect(checkpoint[venueKey("kraken", "TAOUSD")]?.lastWrittenMs).toBe(100);
    expect(checkpoint[venueKey("binance", "TAOUSDT")]?.lastWrittenMs).toBe(200);
  });

  it("overwrites only the written venue's progress on a later checkpoint", () => {
    const key = venueKey("kraken", "TAOUSD");
    writePriceBackfillVenueCheckpoint(venueKey("binance", "TAOUSDT"), 1);
    writePriceBackfillVenueCheckpoint(key, 100);
    writePriceBackfillVenueCheckpoint(key, 200);
    const checkpoint = readPriceBackfillCheckpoint();
    expect(checkpoint[key]?.lastWrittenMs).toBe(200);
    expect(checkpoint[venueKey("binance", "TAOUSDT")]?.lastWrittenMs).toBe(1);
  });

  it("clearPriceBackfillCheckpoint removes the whole file", () => {
    writePriceBackfillVenueCheckpoint(venueKey("kraken", "TAOUSD"), 100);
    clearPriceBackfillCheckpoint();
    expect(readPriceBackfillCheckpoint()).toEqual({});
  });

  it("clearPriceBackfillCheckpoint on a missing file is a no-op", () => {
    expect(() => clearPriceBackfillCheckpoint()).not.toThrow();
  });
});
