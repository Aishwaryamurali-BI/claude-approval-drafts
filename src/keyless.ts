import type { DraftContext, DraftOutput, Source } from "./types.js";

/** Prefix that makes a keyless draft impossible to mistake for a real one. */
export const KEYLESS_LABEL = "[KEYLESS CANNED DRAFT: no Anthropic credentials configured; not written by Claude]";

/**
 * Deterministic stand-in for Claude when no credentials exist outside
 * production. Same input, same output, so end-to-end tests can assert on it.
 * It quotes no source text, only counts and labels, so it is equally safe to
 * display in screenshots and logs of a dev environment.
 */
export function cannedDraft(context: DraftContext, currentSources: Source[]): DraftOutput {
  const labels = [...new Set(currentSources.map((s) => s.label))].sort().join(", ");
  return {
    body: [
      KEYLESS_LABEL,
      "",
      "Hello,",
      "",
      `Thank you for your patience regarding ${context.subjectId}. ` +
        `This placeholder was built from ${currentSources.length} record(s) captured today (${labels}). ` +
        "With credentials configured, Claude would draft a reply from those records here.",
      "",
      "Best regards,",
    ].join("\n"),
    missing_info: ["Keyless mode: no facts were extracted."],
  };
}
