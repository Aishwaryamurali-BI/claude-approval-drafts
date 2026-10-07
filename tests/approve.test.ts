import { describe, expect, it, vi } from "vitest";
import { ApprovalRejected } from "../src/index.js";
import { context, json, messageJson, mockClient, NOW, setup } from "./helpers.js";

describe("approve is the only persist path", () => {
  it("draft() never writes to the DraftStore; approve() writes exactly once", async () => {
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, drafts } = setup({ client });
    const save = vi.spyOn(drafts, "save");

    const result = await drafter.draft("acme", context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(save).not.toHaveBeenCalled();

    const approved = await drafter.approve(result.draft.draftId, "Hi, it shipped on Oct 4. - Sam", "agent-7");

    expect(approved.ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(drafts.saved[0]).toMatchObject({
      draftId: result.draft.draftId,
      tenantId: "acme",
      subjectId: "TICKET-1001",
      text: "Hi, it shipped on Oct 4. - Sam",
      approver: "agent-7",
      approvedAt: NOW,
      edited: true,
      mode: "live",
      model: "claude-opus-5-5",
    });
  });

  it("marks an unchanged approval as not edited", async () => {
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, drafts } = setup({ client });
    const result = await drafter.draft("acme", context());
    if (!result.ok) throw new Error("expected a draft");

    await drafter.approve(result.draft.draftId, result.draft.output.body, "agent-7");

    expect(drafts.saved[0]!.edited).toBe(false);
  });

  it.each([
    ["unknown id", "draft-does-not-exist", "text", "agent-7", undefined, "unknown_draft"],
    ["empty text", "draft-1", "   ", "agent-7", undefined, "empty_text"],
    ["missing approver", "draft-1", "text", " ", undefined, "missing_approver"],
    ["other tenant's draft", "draft-1", "text", "agent-7", "globex", "unknown_draft"],
  ] as const)("rejects %s and saves nothing", async (_name, id, text, approver, tenantId, reason) => {
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, drafts } = setup({ client });
    await drafter.draft("acme", context());

    const result = await drafter.approve(id, text, approver, tenantId ? { tenantId } : undefined);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ApprovalRejected);
    expect(result.error.reason).toBe(reason);
    expect(drafts.saved).toHaveLength(0);
  });

  it("cannot approve the same draft twice", async () => {
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, drafts } = setup({ client });
    const result = await drafter.draft("acme", context());
    if (!result.ok) throw new Error("expected a draft");

    await drafter.approve(result.draft.draftId, "first", "agent-7");
    const second = await drafter.approve(result.draft.draftId, "second", "agent-7");

    expect(second.ok).toBe(false);
    expect(drafts.saved).toHaveLength(1);
  });

  it("expires drafts that were never approved", async () => {
    let now = NOW;
    const { client } = mockClient(() => json(200, messageJson()));
    const { drafter, drafts } = setup({ client, clock: () => now, pendingTtlMs: 60_000 });
    const result = await drafter.draft("acme", context());
    if (!result.ok) throw new Error("expected a draft");

    now = new Date(NOW.getTime() + 61_000);
    const late = await drafter.approve(result.draft.draftId, "too late", "agent-7");

    expect(late.ok).toBe(false);
    expect(drafts.saved).toHaveLength(0);
  });
});
