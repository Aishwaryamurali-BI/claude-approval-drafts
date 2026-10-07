import { describe, expect, it } from "vitest";
import { costUsd } from "../src/index.js";

const M = 1_000_000;

describe("cost math (Opus 5.5: $4 in / $20 out / $0.20 cache read per MTok)", () => {
  it("prices uncached input and output", () => {
    expect(costUsd("claude-opus-5-5", { input_tokens: M, output_tokens: 0 })).toBe(4);
    expect(costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: M })).toBe(20);
  });

  it("prices cache reads at $0.20/MTok", () => {
    expect(costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M })).toBe(0.2);
  });

  it("prices 5-minute cache writes at 1.25x input", () => {
    expect(costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M })).toBe(5);
  });

  it("prices 1-hour cache writes at 2x input when the TTL breakdown is present", () => {
    const cost = costUsd("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: M,
      cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 },
    });
    expect(cost).toBeCloseTo(0.4 * 5 + 0.6 * 8, 9);
  });

  it("adds a realistic mixed call", () => {
    // 350 uncached + 2,000 cache read + 600 cache write + 250 output
    const cost = costUsd("claude-opus-5-5", {
      input_tokens: 350,
      output_tokens: 250,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 600,
    });
    const expected = (350 * 4 + 250 * 20 + 2_000 * 0.2 + 600 * 4 * 1.25) / M;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it("treats null cache fields as zero", () => {
    expect(
      costUsd("claude-opus-5-5", {
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
    ).toBeCloseTo(0.0004, 12);
  });

  it("returns null for a model missing from the price table", () => {
    expect(costUsd("some-future-model", { input_tokens: 1, output_tokens: 1 })).toBeNull();
  });
});
