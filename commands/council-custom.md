---
description: Convene the council exactly as you specify it — you pick the members, mode, files and budget, and it runs that without weighing whether it was worth it.
argument-hint: <the question> + how you want it run, in plain words ("only codex and gemini", "grade it out of 10", "use lenses", "20 minutes", "wait for it")
---

The user asked for a council **explicitly**, and said how they want it run:

**$ARGUMENTS**

## What is different about this command, and nothing else is

`/council` weighs whether a council earns its time and **may talk the user out of it**. This one does
not. They typed it deliberately: the skill fires on its own judgement, `/council` on yours, this on
theirs.

So the "is the answer knowable?" gate does **not** apply. Skip it. If you think a `grep` would settle
it, say so in one sentence *after* the run is going — not instead of starting it.

Everything else — how to read the result, how to synthesise, what to record — is the **same discipline
as `/council`**, and it is written once in `skills/council/SKILL.md`. Follow it from there. Do not
restate it here; two copies of the same doctrine is how they drift apart, and they already had.

Only these stop you, and they are all real:

- **no member CLI available** — `--preflight` says so, nothing is spent
- **a file they named does not exist** — say which, and ask
- **something they asked for does not exist** — a member not in the roster, a mode there is none of.
  Name the exact problem and the nearest real thing. `--preflight` prints the roster's actual ids.

## Their words → flags

Map what they said. **Do not add flags they did not ask for**, with the single stated exception below.

| They say | Use |
|---|---|
| "only codex and gemini" · "just the Claude ones" | `--members=codex,gemini` / `--members=claude-fable,claude-sonnet` |
| "grade it" · "score it out of 10" · "rate this" | `--rubric` |
| "make them disagree" · "different angles" · "lenses" | `--lenses` |
| "let them see each other" · "a second pass" | `--revise` — roughly doubles the calls |
| "skip the ranking" · "just their opinions" | `--stage1-only` |
| "don't take more than N minutes" · "cap it" | `--timeout=N` — this is the TIME control |
| "rank the reviews too" (alongside a grade) | `--rubric --peer-review` |
| "wait for it" · "stay in the foreground" | omit `--detach` (see below) |
| "include grok" · "everything in the roster" | `--allow-uncontained` — **and say why it is off by default** |
| "use my project's roster" | `--local-roster` + `--allow-uncontained` — see below |

Two mappings people get wrong, so get them right:

- **"quick" is ambiguous.** It usually means *"don't make me wait"*, which is `--timeout=N`, not
  `--stage1-only`. `--stage1-only` changes **what they get** — no peer review, no tally — rather than
  how long it takes. If they said "quick", ask which they meant, or use `--timeout` and say so.
- **Members are whatever the roster holds.** Do not assume a count or which one is uncontained; run
  `--preflight` and read it. The roster changes, and prose in this file cannot.

**If they said nothing about members, run all of them.** Narrowing is a choice they did not make.

## The one flag added for them, and why it is honest to say so

**`--detach` goes on by default.** That is an exception to the rule above and it would be dishonest to
present it as anything else, so: measured across 34 successful member answers in this repo's own event
streams, the median was **5m08s** and the slowest **10m28s** — per member, in parallel. Blocking a
session for that is not a neutral default either, and if the session dies mid-run the members have
already been spent for nothing.

So detached is the default, `"wait for it"` turns it off, and **you tell them which they got.**

```bash
# print the command first — a user who typed this wants to see it before it costs ten minutes
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <files> [their flags] --detach

node "$CLAUDE_PLUGIN_ROOT/scripts/feed.mjs" --every=30    # one line per event, plus a heartbeat
node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs"             # ask once, any time, from any session
```

**Quote the question safely.** It is the user's prose and may contain `"`, `$` or a backtick, any of
which a double-quoted shell string will mangle or expand. Prefer single quotes, or put the question
last after `--`:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" --context <files> [flags] -- <the question, verbatim>
```

**Do not sit in a loop waiting.** The run has its own process group and no parent, so it survives this
session — `tests/survives-session-death.mjs` proves that by SIGKILLing the launcher mid-run. Afterwards
`status.mjs` finds it again with no arguments.

## Two warnings, once each, without lecturing

Both apply to `/council` as well — the flags belong to the script, not to this command.

- **`--allow-uncontained` admits a member measured able to write to any absolute path.** The pack is
  repository content, and a file in it can carry an instruction aimed at whoever reads it next. Say
  that in one sentence, then do as asked; the run file records it either way.
  `scripts/verify-containment.mjs` is what decides which member that is — do not name one from memory.
- **A repo-local roster chooses what gets executed.** `--local-roster` therefore also needs
  `--allow-uncontained`, because `contained` is stripped from anything the working directory supplies.
  That is the reason the flags are separate, not an inconvenience to route around.

## Then follow the reading discipline in the skill

`skills/council/SKILL.md` holds it, in one place: read every stage-1 answer before the rankings, treat
disagreement as the output, read the diagnostics above the score, weigh by confidence rather than
count, carry the minority view even when overruling it, and verify every number yourself.

**Do not adopt the council's answer.** It is material for a judgement, never the judgement. And if the
run came back degraded, say so — presenting four answers as five is the outcome this package is built
against.
