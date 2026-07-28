---
description: Put a hard question to five models across four vendors, anonymise, rank, then synthesise it yourself.
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
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file> [<file>...]
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file> --revise    # +MoA round
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --preflight                  # who is available; free
```

## Reading the result

1. **Read every stage-1 answer before the rankings.** The tally pulls you toward consensus;
   form your own view first or you are synthesising their synthesis.
2. **Where they disagree is the output.** Record both sides. Averaging five models produces
   something none of them would defend.
3. **Read the bias diagnostics above the score.** Self-enhancement and verbosity are printed
   every run, flagged when present.
4. **Every number goes through your own verification**, however many members stated it.

## Then write the synthesis where the work is

A card, a decision record, a PR comment — not in chat. Cite the run file by path.

**Do not adopt a council's answer.** It is material for your judgement. If you are running it
because a choice is uncomfortable rather than unclear, you will get a well-argued average and
a decision nobody owns.
