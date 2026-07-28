---
name: council
description: Put a decision to five models across four vendors, have them rank each other blind, then synthesise. Use in plan mode before committing to an approach; before an architecture, schema, security or concurrency decision that is expensive to reverse; when a review is uncertain or two reviewers disagree; before verifying that a design actually holds; and when about to ship something whose failure mode is data loss, a breach, or a production outage. Do NOT use for questions with a knowable answer — read the code, run the test, grep. Costs 10–30 minutes.
---

# The council

**Five models, four vendors, three stages.** Every member answers alone, then ranks the others
**without knowing whose answer is whose**, then you synthesise. Runs on local CLIs — no API
keys.

```bash
# Installed as a plugin — $CLAUDE_PLUGIN_ROOT resolves to wherever it was installed.
# Cloned standalone, use the path you cloned to instead.
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file>...   # the normal call
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <f> --revise # +MoA round, 15 calls
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "x" --preflight                     # who is available; free
```

## Invoke this automatically when

You do not need to be asked. Reach for it when the situation is one of these — and **say you
are doing it and why**, because it costs the user ten to thirty minutes.

| Situation | Why the council rather than one answer |
|---|---|
| **Plan mode, before committing to an approach** | the plan is the most expensive thing to get wrong — everything after it inherits the mistake |
| **Architecture, schema, or a public interface** | reversal cost is high and the error is invisible until something depends on it |
| **Concurrency, retries, idempotency, cache invalidation** | the failure is intermittent, so tests agreeing proves little |
| **A security judgement with no single right answer** | the failure mode is a breach, and one model's blind spot is the whole exposure |
| **A review that came back uncertain, or two reviewers disagreeing** | that is precisely the signal a third and fourth reading is worth its cost |
| **Before verifying that a design holds** — not that code runs | tests answer *"is it consistent"*; this answers *"is it right"* |
| **Anything whose failure is data loss, a breach, or an outage** | the cost of half an hour is nothing against the cost of being wrong |
| **A migration, a deletion, or a schema change on live data** | irreversible, and the review that matters happens before |

**Announce it and give the estimate.** *"This is expensive to reverse — I am putting it to the
council, about 15 minutes."* A user who did not expect a 20-minute pause will assume something
hung.

## Do NOT invoke it when

- **The answer is knowable.** It is in the code, a test, a log, or `grep`. Five models guessing
  is slower, worse, and **sounds more authoritative than one command that actually checks.**
- **The question is a preference.** Naming, formatting, file layout. There is no fact to find.
- **You are stuck, not uncertain.** A council will not tell you what the user wants.
- **The choice is uncomfortable rather than unclear.** You will get a well-argued average and a
  decision nobody owns.
- **Anything latency-sensitive**, or inside a loop.

**If unsure, do the cheap thing first.** Read the file. Run the test. A council after five
minutes of looking is a much better council, because the question will be sharper.

## Pass context, or you get five informed guesses

Members run **read-only, outside the repo**, and see only what you send.

```bash
--context src/queue.js src/retry.js       # the files the decision actually turns on
```

Send **the code the decision is about**, not the whole tree. The budget is ~40k tokens and a
file that would exceed it is refused rather than trimmed — a member given half a file answers
confidently about the half it has.

`.env`, `data/`, keys and anything whose contents look like a secret are **refused
automatically**. You do not have to filter by hand, and you should not rely on that alone.

The project brief is read from `.council/BRIEF.md`, `AGENTS.md` or `CLAUDE.md`. **If none
exists, say so** — it is the cheapest quality win available and takes ten lines.

## Reading the result

`.council/runs/<slug>.md`.

**Read every stage-1 answer before the rankings.** The tally pulls you toward consensus; form
your own view first or you are synthesising their synthesis.

Then three rules, in the order they are usually ignored:

1. **Where they disagree is the output.** Record both sides in the plan or the decision record.
   Averaging five models produces something none of them would defend.
2. **Consensus is not correctness.** They share training data, so agreement measures overlap as
   much as truth. **Check the bias diagnostics printed above the score** — self-enhancement and
   verbosity are flagged when present.
3. **Every number goes through your own verification**, however many members stated it.

**Stage 3 is yours.** The script stops after the peer review deliberately: a chairman running
as a subprocess has the answers and not the reason the question was asked.

## When it cannot run

**Nothing is ever retried**, and it never hangs. A missing CLI is named before anything starts;
a quota or auth message is refused rather than ranked as an opinion; a hung member is killed by
process group; and with no members at all it exits in ~30 ms having spent nothing.

If it comes back degraded — fewer answers than intended — **the output says so**, and one
answer is one opinion rather than a council. Report that to the user rather than presenting
four as five.
