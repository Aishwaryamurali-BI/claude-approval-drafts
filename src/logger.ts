/**
 * A logger wrapper that cannot log message bodies.
 *
 * Prompts and drafts carry customer data, so the rule is structural rather
 * than a convention: only allowlisted metadata keys get through, every value
 * must be a scalar, strings are capped, and the event name must look like an
 * event name (not a sentence someone pasted a prompt into). Anything else is
 * dropped and the dropped key names are reported instead.
 *
 * The drafter always wraps whatever logger you pass in with this, so a
 * well-meaning `logger.info("draft", { prompt })` elsewhere in the library is
 * impossible, not merely discouraged.
 */

/** Anything console-shaped works: console, pino, winston, a test spy. */
export interface BaseLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type Scalar = string | number | boolean | null;
export type SafeMeta = Record<string, Scalar>;

export interface SafeLogger {
  info(event: string, meta?: SafeMeta): void;
  warn(event: string, meta?: SafeMeta): void;
  error(event: string, meta?: SafeMeta): void;
}

/** Keys that describe a call without containing its content. */
export const ALLOWED_META_KEYS: ReadonlySet<string> = new Set([
  "tenantId",
  "draftId",
  "subjectId",
  "approver",
  "model",
  "servedBy",
  "mode",
  "status",
  "kind",
  "code",
  "retryable",
  "stopReason",
  "refusalCategory",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "spentUsd",
  "limitUsd",
  "sourceCount",
  "edited",
  "durationMs",
  /** The provider's own error text, already truncated by ProviderError. */
  "providerMessage",
]);

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_STRING = 200;

function sanitize(event: string, meta: SafeMeta | undefined): [string, Record<string, Scalar>] {
  const safeEvent = EVENT_NAME.test(event) ? event : "invalid_event_name";
  const out: Record<string, Scalar> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(meta ?? {})) {
    const scalar =
      value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string";
    if (!ALLOWED_META_KEYS.has(key) || !scalar) {
      dropped.push(key.slice(0, 40));
      continue;
    }
    out[key] = typeof value === "string" && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}…` : value;
  }
  if (dropped.length > 0) out.droppedKeys = dropped.join(",");
  return [safeEvent, out];
}

export function createSafeLogger(base: BaseLogger): SafeLogger {
  return {
    info: (event, meta) => base.info(...sanitize(event, meta)),
    warn: (event, meta) => base.warn(...sanitize(event, meta)),
    error: (event, meta) => base.error(...sanitize(event, meta)),
  };
}

/** A logger that discards everything; handy default for tests. */
export const silentLogger: BaseLogger = { info() {}, warn() {}, error() {} };
