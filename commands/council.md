---
description: Put a hard question to four models across three vendors, anonymise, rank, then synthesise it yourself.
argument-hint: <the question> [--context <file>...]
---

Run the council on: **$ARGUMENTS**

## Before spending the time

1. **Check it is worth a council.** If the answer is knowable — it is in the code, a test, or a
   command — say so and stop. A council guessing costs 10–30 minutes and reads as more
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

**The reading discipline lives in one place: `skills/council/SKILL.md`.** Follow it from there rather
than from a copy — read every stage-1 answer before the rankings, treat disagreement as the output,
read the diagnostics above the score, weigh by confidence rather than by count, carry the minority view
even when you overrule it, and verify every number yourself.

It was duplicated here and in `/council-custom`, and the two copies had already drifted — this one's
numbered list ran 1, 2, 3, 4, 5, 4. That is what two sources of the same doctrine does, reliably, and it
is why there is now one.

`.council/runs/<slug>.md` is the run. `<slug>.json` is the same thing for a program.

## Two things the flags cost, worth saying once

These belong to the script, so they apply to `/council-custom` identically.

- **`--allow-uncontained` admits a member measured able to write to any absolute path.** The pack you
  send is repository content, and a file in it can carry an instruction aimed at whoever reads it next.
  `scripts/verify-containment.mjs` decides which member that is — do not name one from memory.
- **A repo-local roster chooses what gets executed**, so `--local-roster` also needs
  `--allow-uncontained`. The flags are separate for that reason.

## Then write the synthesis where the work is

A card, a decision record, a PR comment — not only in chat. Cite the run file by path.

**Do not adopt a council's answer.** It is material for your judgement. If you are running it because a
choice is uncomfortable rather than unclear, you will get a well-argued average and a decision nobody
owns.
