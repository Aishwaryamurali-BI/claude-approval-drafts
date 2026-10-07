import { describe, expect, it } from "vitest";
import { createSafeLogger } from "../src/index.js";
import {
  apiError,
  context,
  json,
  messageJson,
  mockClient,
  SECRET_IN_OUTPUT,
  SECRET_IN_SOURCE,
  setup,
  spyLogger,
} from "./helpers.js";

describe("safe logger", () => {
  it("drops non-allowlisted keys and reports only their names", () => {
    const { logger } = spyLogger();
    const safe = createSafeLogger(logger);

    safe.info("draft.created", { tenantId: "acme", prompt: SECRET_IN_SOURCE, content: SECRET_IN_OUTPUT });

    expect(logger.info).toHaveBeenCalledWith("draft.created", { tenantId: "acme", droppedKeys: "prompt,content" });
  });

  it("drops non-scalar values even under allowed keys", () => {
    const { logger } = spyLogger();
    const safe = createSafeLogger(logger);

    safe.warn("x", { tenantId: { nested: SECRET_IN_SOURCE } as unknown as string });

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_IN_SOURCE);
  });

  it("refuses event names that look like free text", () => {
    const { logger } = spyLogger();
    createSafeLogger(logger).error(`Claude said: ${SECRET_IN_OUTPUT}`);
    expect(logger.error).toHaveBeenCalledWith("invalid_event_name", {});
  });

  it("caps string values", () => {
    const { logger } = spyLogger();
    createSafeLogger(logger).info("x", { providerMessage: "y".repeat(1000) });
    const meta = logger.info.mock.calls[0]![1] as { providerMessage: string };
    expect(meta.providerMessage.length).toBeLessThanOrEqual(200);
  });
});

describe("the drafter never logs prompt or response bodies", () => {
  it("across success, approval, refusal, bad output, provider error, and keyless", async () => {
    const responses = [
      json(200, messageJson()),
      json(200, messageJson({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } })),
      json(200, messageJson({ content: [{ type: "text", text: `not json ${SECRET_IN_OUTPUT}` }] })),
      apiError(400, "invalid_request_error", "messages.0: bad request"),
    ];
    const { client } = mockClient(() => responses.shift()!);
    const live = setup({ client });

    const ok = await live.drafter.draft("acme", context());
    if (!ok.ok) throw new Error("expected a draft");
    await live.drafter.approve(ok.draft.draftId, `Edited reply ${SECRET_IN_OUTPUT}`, "agent-7");
    await live.drafter.draft("acme", context());
    await live.drafter.draft("acme", context());
    await live.drafter.draft("acme", context());

    const keyless = setup({ env: {} });
    const k = await keyless.drafter.draft("acme", context());
    if (!k.ok) throw new Error("expected a keyless draft");
    await keyless.drafter.approve(k.draft.draftId, `Edited ${SECRET_IN_SOURCE}`, "agent-7");

    for (const everything of [live.everything(), keyless.everything()]) {
      expect(everything).not.toContain(SECRET_IN_SOURCE);
      expect(everything).not.toContain(SECRET_IN_OUTPUT);
      expect(everything).not.toContain("Where is my parcel");
      expect(everything).not.toContain("droppedKeys"); // the library itself never even tries
    }
    // Sanity: the logger did receive the events.
    expect(live.logger.info).toHaveBeenCalledWith("draft.created", expect.objectContaining({ inputTokens: 420 }));
    expect(live.logger.warn).toHaveBeenCalledWith("draft.refusal", expect.any(Object));
    expect(live.logger.error).toHaveBeenCalledWith("draft.provider_error", expect.objectContaining({ status: 400 }));
  });
});
