# How it works: a study guide

This guide explains each design decision in plain English and points to where it lives in the code. The last section has six interview questions with answers you can give from this repo.

## The whole thing in one paragraph

`createDrafter()` in `src/drafter.ts` returns two functions. `draft()` runs two cheap checks: is there anything recorded today, and does this tenant have allowance left. Only if both pass does it ask Claude for a JSON draft. It records what the call cost and hands the draft back without saving it. `approve()` takes the text the person actually approved and saves that. Everything else in the repo supports those two functions: typed errors, cost math, a logger that can't leak, in-memory stores, and tests.

## Design decisions, one at a time

### 1. Refuse early when there is nothing to draft (422)

**What:** `draft()` drops sources whose text is blank or that were not recorded today (`isCurrent`, which defaults to `sameUtcDay`). If nothing is left, it returns `NothingToDraft` before touching the allowance or the API.

**Why:** A model given nothing will still write something, and that something is invented. Refusing is cheaper than a call, and more honest than a fluent paragraph built on no facts. 422 ("I understood you, but I can't process this") is the right status: the request was well-formed, the content just isn't enough. Limiting sources to today's means the draft reflects what happened today, not stale notes.

**Where:** the top of `draft()` in `src/drafter.ts`. Tests are in `tests/gates.test.ts`.

### 2. Check the allowance before the call, and meter every call (409)

**What:** Before calling Claude, the drafter reads the tenant's monthly limit from `AllowanceStore` and the month's spending from `UsageStore`. If spending has reached the limit, it returns `AllowanceExhausted`. After every response, including refusals and bad output, it writes a `UsageRecord` with the token counts and USD cost.

**Why:** A check after the call can't stop the spend that already happened. 409 ("conflict with the current state") tells the UI that this isn't a bug, the account is just in a state where AI drafting is off. The UI should hide the AI button and show the normal editor. Recording usage on refusals and bad output matters because those calls are still billed.

**Where:** `draft()` gate 2 and the usage block after the call. The cost math is in `src/pricing.ts`. Tests are in `tests/gates.test.ts` (which asserts the HTTP client is never called) and `tests/pricing.test.ts`.

**Note:** there's a small race. Two simultaneous requests can both pass the check and push spending slightly over the limit. For a soft monthly cap that's acceptable. A hard cap would need an atomic reserve-then-settle step in the database.

### 3. Strict JSON through structured outputs

**What:** The request sets `output_config.format` to `betaZodOutputFormat(DraftOutputSchema)` and calls `client.beta.messages.parse`. The API constrains the model to the schema, and zod validates it again on the way in. The schema has two fields: `body` (the draft) and `missing_info` (facts the draft needed but didn't have, shown to the reviewer).

**Why:** Free text would force the app to guess where the draft starts and ends. With a schema, the UI gets exactly the fields it renders. `missing_info` turns "the model didn't know" into something the reviewer can see, instead of something hidden in a confident sentence.

**A detail:** the SDK's zod helper throws if parsing fails, and the error message can include a snippet of the model's output. `nonThrowingFormat()` wraps it so a parse failure becomes `parsed_output: null`. The drafter still gets the response (so it can record usage) and returns a `ProviderError{kind:"invalid_output"}` with a fixed message that contains no output text.

### 4. Check `stop_reason` before reading content

**What:** The drafter classifies the response first: `"refusal"` gives refused, `"max_tokens"` gives truncated, a missing parse gives invalid_output, and only otherwise is it drafted.

**Why:** On a refusal, `content` may be empty. On truncation, the JSON is cut off partway. Reading `content[0]` blindly would crash, or worse, show half a sentence as a draft. Opus 5.5 has safety classifiers that can decline even benign requests, so the request opts into `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). The API then retries a decline on a recommended fallback model within the same call. If the whole chain still refuses, the refusal category is reported, never the explanation text.

### 5. A draft is never saved until a person approves it

**What:** `draft()` keeps the draft in a small in-memory map (`PendingDrafts`, 1-hour TTL, capped at 1,000 entries) and returns it. Only `approve()` calls `DraftStore.save()`. It saves the human's text, not the model's, along with who approved it, when, whether they edited it, and which model produced the original.

**Why:** If you save AI output immediately, your database fills with text nobody checked, and "draft" turns into "record" without anyone deciding it should. Making approval the only write path means every saved row has a named person responsible for it. The `edited` flag lets you measure how often people change the drafts, which is a cheap quality signal.

**Trade-off:** pending drafts live in process memory, so if you run several server instances you need sticky sessions or a shared cache. Passing `{ tenantId }` to `approve()` makes a cross-tenant draft id look exactly like an unknown one, so ids can't be probed. A draft can be approved only once.

**Where:** `approve()` in `src/drafter.ts`. Tests are in `tests/approve.test.ts`, which spies on `save` and asserts that `draft()` never calls it.

### 6. Logs can't contain bodies, by construction

**What:** `createSafeLogger()` in `src/logger.ts` wraps whatever logger you pass in. The drafter always applies the wrapper and never uses your logger directly. It passes only allowlisted keys (ids, token counts, status, cost...). Each value must be a scalar, strings are capped at 200 characters, and event names must look like `draft.created`. Anything else is dropped, and only the names of the dropped keys are reported.

**Why:** "Please don't log prompts" is a convention, and conventions break during a 2 a.m. debugging session. An allowlist makes the safe behaviour the only one available. Provider errors carry only the status and a truncated provider message. Separately, when the library builds the SDK client itself, it pins `logLevel: "warn"`, because `ANTHROPIC_LOG=debug` would make the SDK log full request and response bodies.

**Where:** tests are in `tests/logging.test.ts`. They run every path (success, approval, refusal, bad output, provider error, keyless) with sentinel strings in the inputs and outputs, and assert that no sentinel reaches the logger spy.

### 7. Keyless in dev and test, and a hard error in production

**What:** If no client is passed and neither `ANTHROPIC_API_KEY` nor `ANTHROPIC_AUTH_TOKEN` is set, the drafter runs in keyless mode. It returns `cannedDraft()`, a deterministic text that starts with `[KEYLESS CANNED DRAFT ...]`, quotes no source text, and costs $0. Both gates still apply. If `NODE_ENV=production` and there are no credentials, `createDrafter()` throws.

**Why:** Contributors and CI can run the whole flow, including end-to-end tests that assert on exact text, without a secret. The label makes it impossible to mistake the canned text for a real draft. In production, a missing key has to fail at boot. The alternative is a deploy that looks healthy while every user gets placeholder text.

### 8. Prompt caching: the marker is there, but measured, not assumed

**What:** The system block carries `cache_control: { type: "ephemeral" }`. Only static text goes in it: your instructions plus `OUTPUT_RULES`. Per-ticket data goes in the user message.

**Why it's probably inert here:** Opus 5.5 caches only prefixes of at least 512 tokens. The example prefix is about 310 tokens by a chars/4 estimate. Below the minimum, the API ignores the marker without an error, and `cache_creation_input_tokens` and `cache_read_input_tokens` both stay at 0. The structured-output schema adds an unknown number of tokens to the rendered prompt, which is exactly why the README says to measure. The example's live mode sends the same prefix twice and prints both fields.

**Why keep it:** while inert it costs nothing, and it starts working by itself if the instructions grow. Keeping customer data out of the system block also makes that block byte-identical across tenants (there's a test for this), so one cache entry could serve every tenant.

### 9. Effort "low", set explicitly

Opus 5.5 always thinks, and sending `thinking: {type: "disabled"}` is a 400 error. Effort is the only control, and the model's default is `medium`. A support reply built from facts already in the prompt is a bounded rewrite, not a multi-step problem. Setting `low` keeps the button fast and cheap. The comment in `DrafterOptions.effort` says when to raise it: when an eval shows `low` dropping facts.

## Six likely interview questions

**1. "Why not just save the AI's output and let people edit it afterwards?"**
Because then the default is that unchecked text becomes a record. In this design, `draft()` can't write to the `DraftStore`. Only `approve()` can, and it saves the person's text with their id and an `edited` flag. The test in `tests/approve.test.ts` spies on `save()` to prove `draft()` never calls it. It also gives you a metric for free: the share of drafts that were approved without edits.

**2. "How do you stop one customer from running up a huge bill?"**
Each tenant has a monthly USD allowance that is checked before the API call. Spending comes from a usage table that records every call's tokens and cost, including refusals, because those are billed too. When the allowance is spent, the API returns 409 and the UI falls back to manual writing, so the feature degrades instead of breaking. The test asserts that the HTTP transport is never called in that case. The honest caveat is a small race between concurrent requests. For a hard cap, I'd reserve the estimated cost atomically before the call and settle it afterwards.

**3. "How do you make sure sensitive data never ends up in logs?"**
Structurally, not by convention. The drafter only ever logs through `createSafeLogger`, which allows a fixed set of metadata keys with scalar values and caps strings. Errors are reduced to status, kind and a truncated provider message. Two less obvious leak paths are also closed: the SDK's zod parse error can include model output, so I swallow it and return a fixed message, and `ANTHROPIC_LOG=debug` makes the SDK log bodies, so I pin the client's log level. The test puts sentinel strings through every path and asserts that none reach the logger.

**4. "What happens when the model refuses or returns garbage?"**
`stop_reason` is checked before content. A refusal becomes a typed `ProviderError` with the refusal category. `max_tokens` becomes `truncated`. A schema mismatch becomes `invalid_output`. Usage is recorded in all three cases. For refusals, I opt into server-side `fallbacks: "default"`, so a false-positive classifier decline is retried on a fallback model within the same call. Because the fallback model has different prices, cost is calculated per attempt from `usage.iterations`. Network and HTTP errors go through an `instanceof` chain, never string matching, and come out as retryable or not.

**5. "Did prompt caching save you money?"**
No, and I can say why. Caching only applies above a model-specific minimum prefix length, which is 512 tokens on Opus 5.5. My static prefix is about 300 tokens, so the marker is ignored without an error: no write charge, no reads. I didn't assume it worked. I checked `cache_read_input_tokens`, and I store cache tokens on every usage row so the number is visible in production. I kept the marker because it's free while inert and switches on if the prompt grows. I didn't pad the prompt to reach the minimum, because at this size the most it could save is about a tenth of a cent per call.

**6. "How do you test an LLM feature without an API key, and is that test meaningful?"**
There are two layers. Keyless mode returns a deterministic, labelled canned draft, so end-to-end tests of the UI flow run in CI with no secret, and production refuses to start without one. For the Claude integration itself, the tests build a real `Anthropic` client with a stubbed `fetch`. That exercises the real SDK: request serialization (model, effort, fallbacks, beta headers, schema), the real `parse` helper, and the real typed error classes for 400/401/404/429/500/529. What it can't prove is the model's behaviour (draft quality, real refusals, real cache numbers). That needs a live run, which the example supports when a key is present.
