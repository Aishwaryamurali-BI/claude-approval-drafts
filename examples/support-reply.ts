/**
 * Drafting a reply to a customer support ticket, end to end.
 *
 *   npm run example                      keyless: deterministic canned draft
 *   ANTHROPIC_API_KEY=... npm run example  live: calls claude-opus-5-5
 *
 * Everything here is fictional: the shop, the customer, the order.
 */
import {
  createDrafter,
  InMemoryAllowanceStore,
  InMemoryDraftStore,
  InMemoryUsageStore,
  OUTPUT_RULES,
  type DraftContext,
} from "../src/index.js";

const INSTRUCTIONS = `You draft replies to customer support tickets for Northwind Kettles, a small online shop that sells tea kettles and accessories.
Voice: warm, plain, and brief. Three short paragraphs at most. No exclamation marks, no emoji.
Open by acknowledging the customer's actual problem in one sentence. Then state what the records show. Then say the next step and when it will happen.
Sign off as "The Northwind Kettles team". Do not promise refunds, replacements, or delivery dates unless the records state them.`;

const today = new Date();
const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

const ticket: DraftContext = {
  subjectId: "TICKET-48213",
  sources: [
    {
      label: "Customer message",
      recordedAt: today,
      text:
        "Hi, my order NK-20931 was supposed to arrive Monday and the tracking page has said " +
        "'label created' for four days. It's a gift for Saturday. Can you tell me what's going on? - Priya",
    },
    {
      label: "Order record",
      recordedAt: today,
      text:
        "Order NK-20931. Item: Copper stovetop kettle 1.7L (x1). Paid. Status: label created 4 days ago, " +
        "no carrier scan. Warehouse note today: parcel found unscanned in outbound cage, handed to carrier at 09:40, " +
        "new tracking event expected tonight. Shipping: standard, 2-4 business days from first scan.",
    },
    // Recorded last week, so the drafter ignores it: drafts use today's data only.
    { label: "Old internal note", recordedAt: lastWeek, text: "Customer asked about a discount code in September." },
  ],
};

const drafts = new InMemoryDraftStore();
const usage = new InMemoryUsageStore();
const drafter = createDrafter({
  model: "claude-opus-5-5",
  instructions: INSTRUCTIONS,
  allowance: new InMemoryAllowanceStore({ "northwind-kettles": 5.0 }),
  usage,
  drafts,
  logger: console, // wrapped in the safe logger: only metadata reaches it
});

function rule(title: string) {
  console.log(`\n--- ${title} ${"-".repeat(Math.max(0, 60 - title.length))}`);
}

rule(`mode: ${drafter.mode}`);
const prefixChars = INSTRUCTIONS.length + OUTPUT_RULES.length;
console.log(`System prefix: ${prefixChars} chars, roughly ${Math.round(prefixChars / 4)} tokens (chars/4 estimate).`);

rule("1. Draft (persists nothing)");
const result = await drafter.draft("northwind-kettles", ticket);
if (!result.ok) {
  console.log(`Drafting failed: ${result.error.code} (HTTP ${result.error.httpStatus}): ${result.error.message}`);
  process.exit(1);
}
console.log(result.draft.output.body);
console.log("\nMissing info flagged for the reviewer:", result.draft.output.missing_info);
console.log(`Saved drafts so far: ${drafts.saved.length}`);

rule("2. Human edits and approves (the only write)");
// The reviewer adds something only a person would know, then approves.
const edited = `${result.draft.output.body.trimEnd()}\n\nP.S. I have asked the carrier to prioritise this parcel. - Sam`;
const approval = await drafter.approve(result.draft.draftId, edited, "agent-sam", { tenantId: "northwind-kettles" });
if (!approval.ok) throw approval.error;
console.log(`Saved drafts now: ${drafts.saved.length} (edited by human: ${approval.approved.edited})`);

rule("3. Usage recorded for the call");
const u = result.usage;
console.log(
  `model=${u.model} input=${u.inputTokens} output=${u.outputTokens} ` +
    `cache_read=${u.cacheReadTokens} cache_write=${u.cacheWriteTokens} cost=$${(u.costUsd ?? 0).toFixed(6)}`,
);

rule("4. Gates");
const empty = await drafter.draft("northwind-kettles", { subjectId: "TICKET-48214", sources: [] });
console.log("No data today ->", empty.ok ? "drafted?!" : `${empty.error.code} (${empty.error.httpStatus})`);
const broke = await drafter.draft("tenant-without-plan", ticket);
console.log("No allowance  ->", broke.ok ? "drafted?!" : `${broke.error.code} (${broke.error.httpStatus})`);

if (drafter.mode === "live") {
  rule("5. Prompt caching: measure, don't assume");
  // Same system prefix again. If the prefix were cacheable, the first call
  // writes it and this one reads it. Below the model's minimum cacheable
  // length, both fields stay 0 and the marker is inert.
  const again = await drafter.draft("northwind-kettles", ticket);
  if (again.ok) {
    console.log(
      `first call:  cache_write=${u.cacheWriteTokens} cache_read=${u.cacheReadTokens}\n` +
        `second call: cache_write=${again.usage.cacheWriteTokens} cache_read=${again.usage.cacheReadTokens}`,
    );
  }
}
