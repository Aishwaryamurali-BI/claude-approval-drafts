import Anthropic from "@anthropic-ai/sdk";
import { vi } from "vitest";
import {
  createDrafter,
  InMemoryAllowanceStore,
  InMemoryDraftStore,
  InMemoryUsageStore,
  type BaseLogger,
  type DrafterOptions,
  type DraftContext,
} from "../src/index.js";

export const NOW = new Date("2026-10-06T10:00:00Z");
export const YESTERDAY = new Date("2026-10-05T10:00:00Z");

/** Distinctive strings that must never reach a log line. */
export const SECRET_IN_SOURCE = "SENTINEL-CUSTOMER-TEXT-7f3a";
export const SECRET_IN_OUTPUT = "SENTINEL-MODEL-OUTPUT-91bc";

export function context(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    subjectId: "TICKET-1001",
    sources: [
      { label: "Customer message", text: `Where is my parcel? ${SECRET_IN_SOURCE}`, recordedAt: NOW },
      { label: "Order record", text: "Order 55-A, shipped 2026-10-04, carrier Parcelfast", recordedAt: NOW },
    ],
    ...overrides,
  };
}

export function messageJson(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      {
        type: "text",
        text: JSON.stringify({ body: `Hi, your order shipped on 2026-10-04. ${SECRET_IN_OUTPUT}`, missing_info: [] }),
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 420, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...overrides,
  };
}

export interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/**
 * A real Anthropic client whose transport is a stub. This exercises the real
 * SDK: request serialization, the beta parse helper, and its typed errors.
 */
export function mockClient(respond: () => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return respond();
  });
  const client = new Anthropic({ apiKey: "test-key-not-real", fetch: fetchSpy, maxRetries: 0, logLevel: "off" });
  return { client, fetchSpy, calls };
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const apiError = (status: number, type: string, message: string) =>
  json(status, { type: "error", error: { type, message } });

export function spyLogger() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies BaseLogger;
  const everything = () => JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
  return { logger, everything };
}

export function setup(overrides: Partial<DrafterOptions> & { limits?: Record<string, number> } = {}) {
  const drafts = new InMemoryDraftStore();
  const usage = new InMemoryUsageStore();
  const allowance = new InMemoryAllowanceStore(overrides.limits ?? { acme: 10 });
  const { logger, everything } = spyLogger();
  let id = 0;
  const drafter = createDrafter({
    model: "claude-opus-5-5",
    instructions: "You draft replies to customer support tickets for a small online shop. Be warm and brief.",
    allowance,
    usage,
    drafts,
    logger,
    clock: () => NOW,
    newId: () => `draft-${++id}`,
    env: {},
    ...overrides,
  });
  return { drafter, drafts, usage, allowance, logger, everything };
}
