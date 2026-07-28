---
name: council
description: Put a decision to four models across three vendors, have them rank each other blind, then synthesise. Use in plan mode before committing to an approach; before an architecture, schema, security or concurrency decision that is expensive to reverse; when a review is uncertain or two reviewers disagree; before verifying that a design actually holds; and when about to ship something whose failure mode is data loss, a breach, or a production outage. Do NOT use for questions with a knowable answer — read the code, run the test, grep. Costs 10–30 minutes.
---

# The council

**Four models, three vendors, three stages** — five and four before one member was measured able
to write files and excluded by default. Every member answers alone, then ranks the others
**without knowing whose answer is whose**, then you synthesise. Runs on local CLIs — no API
keys.

```bash
# Installed as a plugin — $CLAUDE_PLUGIN_ROOT resolves to wherever it was installed.
# Cloned standalone, use the path you cloned to instead.
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file>... --events
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <f> --lenses    # +method diversity
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <f> --revise    # +MoA round
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "Grade this" --context <f>... --rubric # score /10
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "x" --preflight                        # who is here; free
```

**`--detach` implies `--events`**, so the stream is always there to attach to. A human who wants to
watch it directly can run `node "$CLAUDE_PLUGIN_ROOT/scripts/watch.mjs"` in another terminal — tell
them that command rather than leaving them staring at a blank prompt.

**A member's own output cannot be relayed** — measured, every CLI is buffered in plain mode and its
first byte arrives at 90–98% of the run. The progress is a parent-side clock per member. Do not
promise the user streaming text.

## Two things to check before the first run on a machine

Both are cheap, both catch a failure that otherwise looks like an answer:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/verify-containment.mjs"   # can any member write? one currently can
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" --verify-delivery   # does each prompt actually arrive?
```

- **Containment.** `grok` is excluded by default because it was measured writing to arbitrary
  absolute paths and no flag it offers stops it. If a user asks why the council is four members and
  not five, that is the answer. `--allow-uncontained` overrides it and the run file records that.
- **Delivery.** A member whose prompt does not arrive **exits 0 and answers pleasantly.** `agy` given
  a prompt on stdin replies "How can I help you today?" — a fluent answer to an empty question that
  then gets ranked against real ones. The canary is the only thing that catches it.

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

- **The answer is knowable.** It is in the code, a test, a log, or `grep`. A council guessing
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
   Averaging the members produces something none of them would defend.
2. **Consensus is not correctness.** They share training data, so agreement measures overlap as
   much as truth. **Check the bias diagnostics printed above the score** — self-enhancement and
   verbosity are flagged when present.
3. **Every number goes through your own verification**, however many members stated it.
4. **Read the reasoning-overlap number.** It is the measured version of "consensus is not
   correctness": the pack’s own vocabulary is subtracted, so what is left is how much of the
   agreement was five arguments rather than one told five times.
5. **Weigh by confidence, not only by count.** Every answer ends with `CONFIDENCE:` and
   `WOULD CHANGE MY MIND IF:`. Five members agreeing at 55% is a request for more context, not a
   decision — and the second line names the measurement to go and take.
6. **Report the minority view even when you overrule it.** Stage 2 captures
   `MINORITY VIEW WORTH KEEPING` and `WHAT IS LOST IF THE TOP ANSWER WINS` precisely because a
   synthesis destroys them first.

**Stage 3 is yours.** The script stops after the peer review deliberately: a chairman running
as a subprocess has the answers and not the reason the question was asked.

## Never block on a council. Detach it, then be told.

A run is 10–30 minutes. **Do not start one and wait**, and do not wrap it in a long timeout — if this
session is killed, restarted, or times out during those minutes, the members have already been spent
and there is nothing to show. That is the expensive failure, and it is entirely avoidable.

```bash
# 1. Launch. Returns in milliseconds with a pid and paths, on stdout as JSON.
node "$CLAUDE_PLUGIN_ROOT/scripts/council.mjs" "<question>" --context <file>... --detach

# 2. Be notified as it happens — one line per real event, plus a heartbeat.
#    Point your host's background-event mechanism at this. In Claude Code that is Monitor.
node "$CLAUDE_PLUGIN_ROOT/scripts/feed.mjs" --every=30

# 3. Or just ask, any time, from any session. Cheap, exits immediately.
node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs"
```

**`--detach` puts the council in its own process group with no parent** (`PPID` becomes 1) and its
stdio pointed at a log file rather than an inherited pipe. Killing this session cannot reach it.

**Then keep working.** The whole point is that you are free while it runs. Do not poll in a loop and
do not sleep — the feed interrupts you when something happens.

### Reading `status.mjs` — the exit code is the answer

| Exit | Meaning | What to do |
|---|---|---|
| **0** | finished and usable | read the run file and synthesise |
| **1** | failed | report why; nobody answered |
| **2** | no run found | nothing was started |
| **3** | **still running** | nothing. Ask again later; the pid is alive |
| **4** | **died without finishing** | the run is LOST. Say so — the members were spent and there is no synthesis |

**Exit 3 and exit 4 are the pair that matters.** A stream that stopped growing is either a council
thinking hard — normal for minutes at a time — or a process that died and will never write again. They
are indistinguishable from the file alone, so the pid is recorded in the stream and checked against the
kernel. Never report "it is still working" without having checked, and never conclude "it hung" from
silence alone.

### A run from a previous session is still yours

`status.mjs` finds the newest run in `.council/runs/` on its own. If a session ended mid-council, the
next one picks it up — exit 3 means keep waiting, exit 0 means the answer has been sitting there
waiting for you. Nothing needs to be re-run.

### What the feed will and will not tell you

Stage boundaries, each member finishing, the score, and the end. **Not** `member_tick` — that fires
every second, and a thousand notifications is the same as none. Attaching to a run already in progress
folds the whole backlog into one catch-up line.

And it reports **death as an event**: if the process disappears without a terminal event, that is a line
and a non-zero exit, never a quiet stop. A feed that only reports good news cannot be trusted, because a
crashed run and a thinking run produce exactly the same silence.

## Two things that will surprise you if nobody says them

**A repo cannot supply the roster.** `.council/members.json` is ignored unless `--local-roster` is
passed, and even then its `contained` flag is stripped. Every field in a roster is a command this
script executes, so a cloned repository would otherwise choose what runs. If a user asks why their
`.council/members.json` had no effect, that is the answer.

**Windows is refused, not degraded.** Use WSL. Executable lookup and the never-hang teardown are both
POSIX-only, and pretending otherwise reported every member as missing.

## When it cannot run

**Nothing is ever retried**, and it never hangs. A missing CLI is named before anything starts;
a quota or auth message is refused rather than ranked as an opinion; a hung member is killed by
process group; and with no members at all it exits in ~30 ms having spent nothing.

If it comes back degraded — fewer answers than intended — **the output says so**, and one
answer is one opinion rather than a council. Report that to the user rather than presenting
four as five.
