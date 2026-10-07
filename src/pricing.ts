/**
 * Cost math. Prices are USD per million tokens, from Anthropic's published
 * pricing at the time of writing. Check the pricing page before relying on
 * them for billing; this table is for allowance enforcement, not invoicing.
 *
 * Fallback models are listed because a server-side fallback can serve the
 * request on a different model, billed at that model's own rates.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES_PER_MTOK: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
};

/** Cache writes are billed as a multiple of the base input price. */
export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

/** Token counts for one model attempt, in the API's own field names. */
export interface TokenUsage {
  /** Uncached input tokens (full price). Does NOT include cache reads/writes. */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Optional TTL breakdown of cache_creation_input_tokens. */
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

/**
 * USD cost of one attempt, or null when the model is not in the price table
 * (the tokens are still recorded; the caller should fix the table).
 */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = PRICES_PER_MTOK[model];
  if (!price) return null;

  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  // Split writes by TTL when the API tells us; otherwise assume the 5-minute
  // default, which is what an `ephemeral` marker without `ttl` writes.
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = usage.cache_creation ? usage.cache_creation.ephemeral_5m_input_tokens : cacheWrite;

  const usd =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
    write5m * price.input * CACHE_WRITE_MULTIPLIER["5m"] +
    write1h * price.input * CACHE_WRITE_MULTIPLIER["1h"];

  // Round to 1e-9 USD to keep float noise out of stored values.
  return Number((usd / 1_000_000).toFixed(9));
}
