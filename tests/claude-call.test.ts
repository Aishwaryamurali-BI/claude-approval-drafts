import { describe, expect, it } from "vitest";
import { FALLBACK_BETA, ProviderError } from "../src/index.js";
import { apiError, context, json, messageJson, mockClient, SECRET_IN_SOURCE, setup } from "./helpers.js";

describe("the Claude request", () => {
  it("uses the exact model, explicit effort, structured output, default fallbacks", async () => {
    const { client, calls } = mockClient(() => json(200, messageJson()));
    const { drafter } = setup({ client });

    await drafter.draft("acme", context());

    expect(calls).toHaveLength(1);
    const { body, headers, url } = calls[0]!;
    expect(url).toContain("/v1/messages");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.output_config.format.schema.required).toEqual(["body", "missing_info"]);
    expect(body.fallbacks).toBe("default");
    expect(body.thinking).toBeUndefined(); // Opus 5.5 always thinks; disabling it is a 400
    expect(body.temperature).toBeUndefined(); // sampling params are a 400 on Opus 5.5
    const betas = headers.get("anthropic-beta") ?? "";
    expect(betas).toContain(FALLBACK_BETA);
    expect(betas).toContain("structured-outputs");
  });

  it("keeps customer data out of the cached system prefix", async () => {
    const { client, calls } = mockClient(() => json(200, messageJson()));
    const { drafter } = setup({ client });

    await drafter.draft("acme", context());

    const { system, messages } = calls[0]!.body;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(JSON.stringify(system)).not.toContain(SECRET_IN_SOURCE);
    expect(JSON.stringify(system)).not.toContain("TICKET-1001");
    expect(messages[0].content).toContain(SECRET_IN_SOURCE);
  });

  it("produces byte-identical system prefixes across tenants and tickets", async () => {
    const { client, calls } = mockClient(() => json(200, messageJson()));
    const { drafter } = setup({ client, limits: { acme: 10, globex: 10 } });

    await drafter.draft("acme", context());
    await drafter.draft("globex", context({ subjectId: "TICKET-2002" }));

    expect(JSON.stringify(calls[0]!.body.system)).toBe(JSON.stringify(calls[1]!.body.system));
  });
});

describe("structured output parse path", () => {
  it("returns the parsed draft, records usage, and saves nothing", async () => {
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, usage, drafts } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.output.body).toMatch(/^Hi, your order shipped/);
    expect(result.draft.output.missing_info).toEqual([]);
    expect(result.draft.mode).toBe("live");
    // 420 * $4/M + 180 * $20/M = 0.00168 + 0.0036
    expect(result.costUsd).toBeCloseTo(0.00528, 9);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ outcome: "drafted", inputTokens: 420, outputTokens: 180 });
    expect(drafts.saved).toHaveLength(0);
  });

  it("reports invalid_output (no body text) and still records usage", async () => {
    const bad = messageJson({ content: [{ type: "text", text: "Sure! Here is a reply: not json" }] });
    const { client } = mockClient(() => json(200, bad));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProviderError);
    expect((result.error as ProviderError).kind).toBe("invalid_output");
    expect(result.error.message).not.toContain("not json");
    expect(usage.records[0]).toMatchObject({ outcome: "invalid_output", inputTokens: 420 });
  });

  it("reports truncated output on max_tokens", async () => {
    const cut = messageJson({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"body":"Hi, your ord' }] });
    const { client } = mockClient(() => json(200, cut));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as ProviderError).kind).toBe("truncated");
    expect(usage.records[0]!.outcome).toBe("truncated");
  });
});

describe("refusal handling", () => {
  it("checks stop_reason before content and returns a refusal error with its category", async () => {
    const refused = messageJson({
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Declined.", fallback_credit_token: null },
      usage: { input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const { client } = mockClient(() => json(200, refused));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.error as ProviderError;
    expect(error.kind).toBe("refusal");
    expect(error.refusalCategory).toBe("cyber");
    expect(error.retryable).toBe(false);
    expect(usage.records[0]).toMatchObject({ outcome: "refused", inputTokens: 400 });
    // Nothing was drafted, so there is nothing to approve.
    const approve = await drafter.approve("draft-1", "anything", "agent-7");
    expect(approve.ok).toBe(false);
  });

  it("prices each attempt at its own model when a server-side fallback served the request", async () => {
    const fellBack = messageJson({
      model: "claude-opus-4-8",
      content: [{ type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } }, ...messageJson().content],
      usage: {
        input_tokens: 400,
        output_tokens: 150,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 400, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 400, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    });
    const { client } = mockClient(() => json(200, fellBack));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(true);
    // 400*$4/M (declined attempt) + 400*$5/M + 150*$25/M (fallback attempt)
    expect(usage.records[0]!.costUsd).toBeCloseTo(0.0016 + 0.002 + 0.00375, 9);
    expect(usage.records[0]).toMatchObject({ model: "claude-opus-4-8", inputTokens: 800, outputTokens: 150 });
  });
});

describe("typed provider errors (instanceof chain, no string matching)", () => {
  it.each([
    [429, "rate_limit_error", "rate_limited", true, 503],
    [529, "overloaded_error", "unavailable", true, 503],
    [500, "api_error", "unavailable", true, 503],
    [401, "authentication_error", "auth", false, 502],
    [400, "invalid_request_error", "bad_request", false, 502],
    [404, "not_found_error", "bad_request", false, 502],
  ] as const)("HTTP %i -> %s", async (status, type, kind, retryable, httpStatus) => {
    const { client } = mockClient(() => apiError(status, type, "x".repeat(500)));
    const { drafter, usage } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.error as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.httpStatus).toBe(httpStatus);
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message).not.toContain(SECRET_IN_SOURCE);
    expect(usage.records).toHaveLength(0); // no response, nothing billed to record
  });

  it("maps a transport failure to a retryable network error", async () => {
    const { client } = mockClient(() => {
      throw new TypeError("fetch failed");
    });
    const { drafter } = setup({ client });

    const result = await drafter.draft("acme", context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as ProviderError).kind).toBe("network");
    expect((result.error as ProviderError).retryable).toBe(true);
  });
});
