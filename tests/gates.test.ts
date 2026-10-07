import { describe, expect, it } from "vitest";
import { AllowanceExhausted, NothingToDraft } from "../src/index.js";
import { context, messageJson, json, mockClient, NOW, setup, YESTERDAY } from "./helpers.js";

describe("gate 1: nothing to draft", () => {
  it.each([
    ["no sources", []],
    ["only blank sources", [{ label: "Customer message", text: "   \n ", recordedAt: NOW }]],
    ["only yesterday's sources", [{ label: "Customer message", text: "Hello", recordedAt: YESTERDAY }]],
  ])("refuses with 422 and never calls Claude: %s", async (_name, sources) => {
    const { client, fetchSpy } = mockClient(() => json(200, messageJson()));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context({ sources }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(NothingToDraft);
    expect(result.error.httpStatus).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(usage.records).toHaveLength(0);
  });

  it("drops stale sources and sends only today's", async () => {
    const { client, calls } = mockClient(() => json(200, messageJson()));
    const { drafter } = setup({ client });
    const sources = [
      { label: "Old note", text: "STALE-NOTE", recordedAt: YESTERDAY },
      { label: "Customer message", text: "Where is my parcel?", recordedAt: NOW },
    ];

    const result = await drafter.draft("acme", context({ sources }));

    expect(result.ok).toBe(true);
    const userMessage = calls[0]!.body.messages[0].content as string;
    expect(userMessage).toContain("Where is my parcel?");
    expect(userMessage).not.toContain("STALE-NOTE");
  });
});

describe("gate 2: monthly allowance", () => {
  it("returns 409 before any API call when the allowance is spent", async () => {
    const { client, fetchSpy } = mockClient(() => json(200, messageJson()));
    const { drafter, usage } = setup({ client, limits: { acme: 0.5 } });
    await usage.record({
      tenantId: "acme",
      draftId: "earlier",
      at: new Date("2026-10-01T09:00:00Z"),
      model: "claude-opus-5-5",
      mode: "live",
      outcome: "drafted",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.5,
    });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AllowanceExhausted);
    expect(result.error.httpStatus).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only counts the current month", async () => {
    const { client, fetchSpy } = mockClient(() => json(200, messageJson()));
    const { drafter, usage } = setup({ client, limits: { acme: 0.5 } });
    await usage.record({
      tenantId: "acme",
      draftId: "last-month",
      at: new Date("2026-09-30T23:59:00Z"),
      model: "claude-opus-5-5",
      mode: "live",
      outcome: "drafted",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 5,
    });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a tenant with no plan as a zero allowance", async () => {
    const { client, fetchSpy } = mockClient(() => json(200, messageJson()));
    const { drafter } = setup({ client });
    const result = await drafter.draft("unknown-tenant", context());
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
