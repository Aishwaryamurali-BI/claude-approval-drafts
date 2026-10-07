import { describe, expect, it } from "vitest";
import {
  createDrafter,
  InMemoryAllowanceStore,
  InMemoryDraftStore,
  InMemoryUsageStore,
  KEYLESS_LABEL,
  silentLogger,
} from "../src/index.js";
import { context, setup } from "./helpers.js";

const base = () => ({
  model: "claude-opus-5-5",
  instructions: "Draft support replies.",
  allowance: new InMemoryAllowanceStore({ acme: 10 }),
  usage: new InMemoryUsageStore(),
  drafts: new InMemoryDraftStore(),
  logger: silentLogger,
});

describe("production guard", () => {
  it("throws at construction when NODE_ENV=production and no credentials exist", () => {
    expect(() => createDrafter({ ...base(), env: { NODE_ENV: "production" } })).toThrow(/no Anthropic credentials/);
  });

  it("treats a blank key as missing", () => {
    expect(() => createDrafter({ ...base(), env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "  " } })).toThrow();
  });

  it("builds a live client in production when a key is set", () => {
    const drafter = createDrafter({ ...base(), env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-test-not-real" } });
    expect(drafter.mode).toBe("live");
  });

  it("falls back to keyless outside production", () => {
    expect(createDrafter({ ...base(), env: { NODE_ENV: "development" } }).mode).toBe("keyless");
    expect(createDrafter({ ...base(), env: { NODE_ENV: "test" } }).mode).toBe("keyless");
    expect(createDrafter({ ...base(), env: {} }).mode).toBe("keyless");
  });
});

describe("keyless mode", () => {
  it("returns a deterministic, clearly labeled canned draft", async () => {
    const a = setup({ env: {} });
    const b = setup({ env: {} });

    const first = await a.drafter.draft("acme", context());
    const second = await b.drafter.draft("acme", context());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.draft.output).toEqual(second.draft.output);
    expect(first.draft.output.body.startsWith(KEYLESS_LABEL)).toBe(true);
    expect(first.draft.mode).toBe("keyless");
    expect(first.costUsd).toBe(0);
  });

  it("still enforces both gates and still records usage", async () => {
    const { drafter, usage } = setup({ env: {}, limits: { acme: 0 } });

    const empty = await drafter.draft("acme", context({ sources: [] }));
    const exhausted = await drafter.draft("acme", context());

    expect(empty.ok || empty.error.code).toBe("nothing_to_draft");
    expect(exhausted.ok || exhausted.error.code).toBe("allowance_exhausted");
    expect(usage.records).toHaveLength(0);

    const ok = await setup({ env: {} });
    await ok.drafter.draft("acme", context());
    expect(ok.usage.records[0]).toMatchObject({ mode: "keyless", costUsd: 0, inputTokens: 0 });
  });

  it("does not quote source text in the canned draft", async () => {
    const { drafter } = setup({ env: {} });
    const result = await drafter.draft("acme", context());
    if (!result.ok) throw new Error("expected a draft");
    expect(result.draft.output.body).not.toContain("Where is my parcel");
  });
});
