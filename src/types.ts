import { z } from "zod";

/** One piece of recorded data the draft may be built from. */
export interface Source {
  /** Short label shown to the model, e.g. "Customer message" or "Order record". */
  label: string;
  text: string;
  /** When this was recorded. Only current sources are sent (see `isCurrent`). */
  recordedAt: Date;
}

export interface DraftContext {
  /** What the draft is about (ticket id, case id...). Opaque to the library. */
  subjectId: string;
  sources: Source[];
}

/**
 * The strict JSON shape Claude must return. Structured outputs constrain the
 * model to this schema; zod validates it again on the way in.
 */
export const DraftOutputSchema = z.object({
  /** The proposed text, for a human to edit. */
  body: z.string(),
  /** Facts the draft needed but the sources did not contain. Shown to the reviewer. */
  missing_info: z.array(z.string()),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export type DraftMode = "live" | "keyless";

/** A generated draft. Held in memory only; never written to a store. */
export interface PendingDraft {
  draftId: string;
  tenantId: string;
  subjectId: string;
  output: DraftOutput;
  mode: DraftMode;
  /** Model that produced it (after any fallback), or "keyless". */
  model: string;
  createdAt: Date;
}

/** What approve() persists: the human's text, with provenance. */
export interface ApprovedDraft {
  draftId: string;
  tenantId: string;
  subjectId: string;
  text: string;
  approver: string;
  approvedAt: Date;
  /** True when the human changed the generated body before approving. */
  edited: boolean;
  mode: DraftMode;
  model: string;
}

export interface UsageRecord {
  tenantId: string;
  draftId: string;
  at: Date;
  /** Model that served the request (after any fallback), or "keyless". */
  model: string;
  mode: DraftMode;
  outcome: "drafted" | "refused" | "truncated" | "invalid_output";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when the serving model is missing from the price table. */
  costUsd: number | null;
}

/** The one place approved drafts are written. Only approve() calls save(). */
export interface DraftStore {
  save(draft: ApprovedDraft): Promise<void>;
}

/** Per-tenant monthly allowance, in USD. */
export interface AllowanceStore {
  monthlyLimitUsd(tenantId: string): Promise<number>;
}

/** Every Claude call is recorded here, including refusals and bad output. */
export interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  /** Sum of costUsd for the tenant in a "YYYY-MM" (UTC) month. */
  spentUsd(tenantId: string, month: string): Promise<number>;
}
