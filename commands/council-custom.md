---
description: Convene the council exactly as you specify it — you pick the members, mode, files and budget, and it runs that without weighing whether it was worth it.
argument-hint: <the question> + how you want it run, in plain words ("only codex and gemini", "grade it out of 10", "use lenses", "20 minutes", "wait for it")
---

The user asked for a council **explicitly**, and said how they want it run:

**$ARGUMENTS**

## The only thing that differs from `/council`

`/council` weighs whether a council earns its time and **may talk the user out of it**. This one does
not. They typed it deliberately: the skill fires on its own judgement, `/council` on yours, this on
theirs. So the "is the answer knowable?" gate does **not** apply — skip it. If you think a `grep` would
settle it, say so in one sentence *after* the run is going.

Everything else is identical, and lives in one place: **`skills/council/SKILL.md`** holds how to read a
result, what to weigh, and what to record. Follow it from there. It is deliberately not restated here —
two copies of one doctrine drift, and these two had already done so.

## Put the question in a FILE, never in the shell

```bash
# 1. write the question to a file — no quoting, no escaping, no expansion
cat > /tmp/council-q.txt <<'COUNCIL_EOF'
<the user's question, verbatim, however many lines>
COUNCIL_EOF

# 2. run it
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" --question-file=/tmp/council-q.txt \
  --context <files> [their flags] --detach
```

**Use this form and no other.** Every attempt to quote prose for a shell fails on some prose, and an
earlier version of this file recommended two that fail on common input — measured:

| what was recommended | what happened |
|---|---|
| `'…the user's session?'` | the shell dies on the apostrophe, and English prose is full of apostrophes |
| `-- Is $HOME safe and does \`id -un\` matter?` | `$HOME` expanded and **`` `id -un` `` executed** |

The second was offered *as the safe one*. It turns the user's own words into executed shell. There is
no quoting rule that fixes this, so the fix is not a quoting rule. The heredoc above is quoted
(`<<'COUNCIL_EOF'`), which is what stops expansion inside it.

## Their words → flags

Map what they said. **Do not add flags they did not ask for**, with the single stated exception below.

| They say | Use |
|---|---|
| "only codex and gemini" · "just the Claude ones" | `--members=codex,gemini` — ids come from `--preflight` |
| "grade it" · "score it out of 10" · "rate this" | `--rubric` |
| "make them disagree" · "different angles" | `--lenses` |
| "let them see each other" · "a second pass" | `--revise` — roughly doubles the calls |
| "skip the ranking" · "just their opinions" | `--stage1-only` |
| "don't take more than N minutes" · "cap it" | `--timeout=N`, **in minutes** (1–120) |
| "rank the reviews too" (alongside a grade) | `--rubric --peer-review` |
| "wait for it" · "stay in the foreground" | omit `--detach` |
| "use every member" · "include the excluded one" | `--allow-uncontained` — **and say what it costs** |
| "use my project's roster" | `--local-roster` + `--allow-uncontained` |

Two mappings that are easy to get wrong:

- **"quick" usually means *don't make me wait*,** which is `--timeout=N`. It does **not** mean
  `--stage1-only` — that changes *what they get* (no peer review, no tally) rather than how long it
  takes. If it is genuinely unclear, use `--timeout` and say which you chose; that is a choice you can
  state, not a reason to stop.
- **Never name a member from memory** — not its id, not how many there are, not which one is excluded.
  `--preflight` prints the roster and costs nothing. This file cannot know your roster; that is why
  every row above says "ids come from `--preflight`".

**If they said nothing about members, run all of them.** Narrowing is a choice they did not make.

## The one flag added for them, and why saying so matters

**`--detach` goes on by default**, which is an exception to the rule above, so it is named rather than
hidden. Measured across 34 successful member answers in this repo's own event streams: median
**5m08s**, slowest **10m28s**, per member, in parallel. Blocking a session that long is not a neutral
default either, and if the session dies mid-run the members were spent for nothing.

`--detach` implies `--events`, which is what the feed reads:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/feed.mjs" --every=30    # one line per event, plus a heartbeat
node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs"             # ask once, any time, from any session
```

`"wait for it"` turns detaching off. **Tell them which they got**, and do not sit in a loop waiting —
the run has its own process group and no parent, which `tests/survives-session-death.mjs` proves by
SIGKILLing the launcher mid-run.

## Only these stop you

A closed list, so nothing else becomes an excuse to not run what they asked for:

1. **no member CLI available** — `--preflight` says so and nothing is spent
2. **a file they named does not exist** — say which, and ask
3. **something they asked for does not exist** — a member not in the roster, a mode there is none of.
   Name the exact problem and the nearest real thing; `--preflight` prints the actual ids.

## Two costs, stated once each

Both belong to the script, so `/council` carries them identically.

- **`--allow-uncontained` admits a member measured able to write to any absolute path.** The pack is
  repository content, and a file in it can carry an instruction aimed at whoever reads it next. Say that
  in one sentence, then do as asked; the run file records it either way.
  `scripts/verify-containment.mjs` is what decides which member that is.
- **A repo-local roster chooses what gets executed**, so `--local-roster` also needs
  `--allow-uncontained` — `contained` is stripped from anything the working directory supplies. The
  flags are separate for that reason, not as an inconvenience.
