---
description: Put a hard question to four models across three vendors, anonymise, rank, then synthesise it yourself.
argument-hint: <the question> [--context <file>...]
---

Run the council on: **$ARGUMENTS**

## Before spending the time

1. **Check it is worth a council.** If the answer is knowable — it is in the code, a test, or a
   command — say so and stop. Five models guessing costs 10–30 minutes and reads as more
   authoritative than one `grep`.

2. **Sharpen the question.** A council answers what it is asked. Put the *decision* to them —
   the criterion in doubt, the approach that might be wrong — not a topic.

3. **Pass context, or you get five informed guesses.** Members run outside your repo and see
   only what you send.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file>... --events
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <f> --lenses   # +method diversity
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <f> --revise   # +MoA round
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "Grade this" --context <f>... --rubric # score out of 10
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --preflight               # who is here; free

# then, in another terminal — a 20-minute run should not look like a hang
node "$CLAUDE_PLUGIN_ROOT/scripts/watch.mjs"
```

**Tell the user the `watch.mjs` command.** The progress is a per-member clock, redrawn live; the
members themselves are buffered and cannot be streamed, so do not promise streaming text.

## Reading the result

1. **Read every stage-1 answer before the rankings.** The tally pulls you toward consensus;
   form your own view first or you are synthesising their synthesis.
2. **Where they disagree is the output.** Record both sides. Averaging five models produces
   something none of them would defend.
3. **Read the bias diagnostics above the score.** Self-enhancement, verbosity, family mix and
   **reasoning overlap** are printed every run, flagged when present. Overlap is the measured form
   of "consensus is not correctness" — the pack’s own vocabulary is subtracted, so what remains is
   how much of the agreement was five arguments rather than one told five times.
4. **Weigh by confidence.** Every answer ends with `CONFIDENCE:` and `WOULD CHANGE MY MIND IF:`.
   Agreement at 55% is a request for more context, and that second line names the measurement.
5. **Carry the minority view into the synthesis** even if you overrule it, and say what it cost.
4. **Every number goes through your own verification**, however many members stated it.

## Then write the synthesis where the work is

A card, a decision record, a PR comment — not in chat. Cite the run file by path.

**Do not adopt a council's answer.** It is material for your judgement. If you are running it
because a choice is uncomfortable rather than unclear, you will get a well-argued average and
a decision nobody owns.
