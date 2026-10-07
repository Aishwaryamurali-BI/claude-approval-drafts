/**
 * Typed outcomes a caller can branch on. Each carries an `httpStatus` so a
 * route handler can map it straight to a response, and a stable `code` so the
 * UI can decide how to degrade (e.g. hide the "Draft with AI" button and show
 * the manual editor when the allowance is exhausted).
 *
 * None of these ever carry prompt or response text.
 */
export abstract class DraftError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
}

/** 422: there was nothing current to draft from, so we refuse to call Claude. */
export class NothingToDraft extends DraftError {
  readonly code = "nothing_to_draft";
  readonly httpStatus = 422;
  constructor() {
    super("Nothing recorded today to draft from; write this one manually.");
    this.name = "NothingToDraft";
  }
}

/** 409: the tenant has used its monthly allowance. Checked before any API call. */
export class AllowanceExhausted extends DraftError {
  readonly code = "allowance_exhausted";
  readonly httpStatus = 409;
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super("Monthly AI allowance exhausted; drafting is manual until next month.");
    this.name = "AllowanceExhausted";
  }
}

export type ProviderErrorKind =
  | "auth" // 401/403: bad or missing credentials, not retryable
  | "bad_request" // 400/404/422: our request is wrong, not retryable
  | "rate_limited" // 429: retry later
  | "unavailable" // >=500 incl. 529 overloaded: retry later
  | "network" // no response at all (DNS, reset, timeout)
  | "api" // any other non-2xx
  | "refusal" // HTTP 200 with stop_reason "refusal" (after any fallback)
  | "truncated" // hit max_tokens before the JSON was complete
  | "invalid_output"; // response did not match the schema

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "unavailable", "network"]);

/** Max characters of the provider's own error message we keep. */
export const PROVIDER_MESSAGE_LIMIT = 200;

export function truncate(text: string, limit = PROVIDER_MESSAGE_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * The provider failed or declined. Carries only the HTTP status, a kind, and a
 * truncated provider error message. Never the prompt, never the model output.
 */
export class ProviderError extends DraftError {
  readonly code = "provider_error";
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    readonly status: number | null,
    providerMessage: string,
    /** Refusal category from stop_details, when kind is "refusal". */
    readonly refusalCategory: string | null = null,
  ) {
    super(truncate(providerMessage));
    this.name = "ProviderError";
    this.retryable = RETRYABLE.has(kind);
    this.httpStatus = this.retryable ? 503 : 502;
  }
}

/** approve() was called with something it cannot accept. Nothing was saved. */
export class ApprovalRejected extends DraftError {
  readonly code = "approval_rejected";
  readonly httpStatus: number;
  constructor(readonly reason: "unknown_draft" | "empty_text" | "missing_approver") {
    super(
      reason === "unknown_draft"
        ? "Draft not found or expired; generate a new one or write manually."
        : reason === "empty_text"
          ? "Approved text is empty."
          : "An approver is required.",
    );
    this.name = "ApprovalRejected";
    this.httpStatus = reason === "unknown_draft" ? 404 : 422;
  }
}
