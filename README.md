# All CLI Council

**Ask five models across four vendors the same hard question. Let them rank each other without
knowing whose answer is whose. Then decide yourself.**

Runs on the CLIs already logged in on your machine — Codex, Grok, Antigravity, Claude.
**No API keys. No accounts. No metered calls.**

```bash
node scripts/council.mjs "Is this cache invalidation actually correct?" --context src/cache.js
```

---

## Why this exists

Asking one model a hard question gives you one model's blind spots. Asking five and averaging
gives you something none of them would defend.

This does neither. It runs [Karpathy's llm-council](https://github.com/karpathy/llm-council)
shape — answer, rank anonymously, synthesise — on **local CLIs instead of a metered API**, and
then does the thing that actually matters: **it measures its own biases and prints them above
the score.**

The first time it was pointed at the controls of the workspace that built it, four of five
members independently found a guard that was theatre, with the exact bypass — one its author
had been using all day without noticing.

---

## What makes it different from just asking five models

Everything below was **measured, not assumed.** Numbers are small-n and say so.

### Judges prefer their own answers, and anonymising does not stop it

Measured across runs: **3 of 4 judges ranked their own unlabelled answer first — 75% against a
20% chance rate.** Mean self-rank 1.5 where 3.0 is unbiased.

A model recognises its own writing. So **self-votes are removed from the tally** and every
answer is scored by the four judges who did not write it.

### Position bias is not shared across judges

Karpathy's version labels responses `A, B, C…` in one fixed order for everyone, so position
bias points the same way for every reviewer and compounds invisibly.

**Here each reviewer gets its own permutation**, seeded from the question so runs stay
reproducible. Where position bias exists, it now shows up as *disagreement* rather than as a
silent shared tilt.

### Every run prints its own error bars

```
| Self-enhancement — judges ranking their own answer 1st | 2/5 (40%) | 20% | ⚠ present |
| Verbosity — correlation(score, answer length)          | 0.06      | 0.00 | ok       |
| Family mix                    | OpenAI 1, xAI 1, Google 1, Anthropic 2 | even | ok      |
```

Verbosity correlation across four runs: **0.64 / −0.18 / 0.53 / 0.06.** Unstable at n=5 —
which is exactly why it is printed rather than corrected. A number with its error bars beside
it is harder to quote out of context than a leaderboard.

### Context is assembled, never granted

Members run **read-only, from a scratch directory outside your repo.** They see only the files
you pass.

That is deliberate. **Read-only in every one of these CLIs means "cannot write" — not "cannot
read."** A member with repo access could read your `.env`. So the pack is built explicitly:
path traversal blocked by realpath containment, symlinks resolved before checking, and files
whose *contents* match a secret shape refused outright.

Verified: passing `.env` is **refused**, not redacted.

### It knows a quota message is not an answer

A CLI that prints `You've hit your usage limit` and **exits 0** used to be ranked as a real
opinion. Now it is refused with its reason shown — as are auth failures, billing errors and
empty output.

### It cannot hang

| Situation | What happens |
|---|---|
| a CLI is not installed | named **before anything runs**, then skipped |
| a member returns a quota / auth error | refused with its reason — not counted |
| a member hangs | SIGTERM, then SIGKILL to its whole **process group** |
| fewer members answer than intended | continues, and **says the council is degraded** |
| **no member available at all** | exits in ~30 ms, code **2**, nothing spent or written |

**Nothing is ever retried.** A CLI that is missing now will be missing in thirty seconds, and
an exhausted quota does not refill while you wait. Retrying turns a clear answer — *"you have
four of five"* — into an indefinite hang.

### The context ceiling was measured, not guessed

| payload | codex | grok | gemini | sonnet |
|---|---|---|---|---|
| **~27k tokens** | ✅ | ✅ | ✅ | ✅ |
| **~80k tokens** | ✅ | ✅ | **❌ ignored the instruction and summarised** | — |

**Capacity was never the limit — instruction-following was.** Every member *accepted* 80k
without erroring; one stopped doing what it was asked, which is the failure that looks like an
answer. The budget sits at 40k, and a file that would exceed it is **refused rather than
trimmed**, because a member given half a file answers confidently about the half it has.

---

## Install

### As a Claude Code plugin

```
/plugin marketplace add developerjillur/all-cli-council
/plugin install all-cli-council@all-cli-council
```

Then `/council <your question>`.

### Standalone

```bash
git clone https://github.com/developerjillur/all-cli-council
node all-cli-council/scripts/council.mjs "<question>" --context <file>
```

Node 22+. No `npm install` — there are no dependencies.

---

## The members

You need **at least one**. It runs with whatever you have and tells you what is missing.

| Member | CLI | Get it |
|---|---|---|
| GPT-5.6 | `codex` | [openai/codex](https://github.com/openai/codex) |
| Grok 4.5 | `grok` | [grok CLI](https://grok.com) |
| Gemini 3.1 Pro | `agy` | [Antigravity](https://antigravity.google) |
| Fable / Sonnet | `claude` | [Claude Code](https://claude.com/claude-code) |

```bash
node scripts/council.mjs "x" --preflight    # who is available. Costs nothing.
```

Override the roster with `.council/members.json` in your own project.

---

## The brief — the cheapest quality win available

Members do not know your project. Without that, you get answers that are **right in general and
wrong for you** — an embeddings API for a codebase that forbids one, a cache on a path where
latency is the product.

So it reads a brief from the first of these it finds:

```
.council/BRIEF.md → AGENTS.md → CLAUDE.md → .cursorrules → .github/copilot-instructions.md
```

If you have an `AGENTS.md`, you already have one. If not, write ten lines of *"rules that are
not preferences"*. It is the single highest-leverage file here.

---

## How a run goes

```
▸ Brief    — AGENTS.md
▸ Context  — 2 file(s), ~13.1k tokens of ~40k budget

▸ Stage 1 — 5 members, in parallel. Minutes, not seconds.
  ✅ Sonnet 5 — 37s     ✅ GPT-5.6 sol — 49s     ✅ Gemini 3.1 Pro — 26s
  ✅ Fable 5 — 76s      ✅ Grok 4.5 — 259s

▸ Stage 1b — revision. Each member sees the others and answers again.   [--revise]

▸ Stage 2 — anonymised peer review, each reviewer sees its own ordering.
  ✅ …

▸ Written: .council/runs/<slug>.md
```

**Stage 3 is you.** The script stops after the peer review on purpose — a chairman running as a
subprocess loses the conversation that made the question worth asking.

Three rules, written into every run file:

1. **Where they disagree is the output.** Record both sides; do not average them.
2. **Consensus is not correctness.** They share training data, so agreement measures overlap as
   much as truth.
3. **Every number goes through your own verification**, however many members stated it.

---

## When not to use it

- **A question with a knowable answer.** Read the code, run the test. Five models guessing is
  worse than one `grep`, slower, and sounds more authoritative.
- **Anything latency-sensitive.** A real run is 10–30 minutes.
- **To avoid deciding.** A council produces material for a judgement, never the judgement.

---

## Honest limitations

Stated because a tool that hides these is worse than one without them.

- **Nobody has measured whether a council answer beats one top-tier model.** The premise is
  borrowed from [Mixture-of-Agents](https://arxiv.org/abs/2406.04692), not measured here. That
  is the experiment this needs most, and it is half a day: same hard question ten times, five
  through the council and five through one model, judged blind.
- **The bias numbers are n=4 and n=5.** Enough to act on. Not enough to publish.
- **Stage 3 — your synthesis — is unmeasured.** The quality claim rests on a step nobody grades.
- **Model IDs age.** `gemini-3.1-pro-high`, `grok-4.5`, `gpt-5.6-sol` are pinned in
  `members.json` and will drift.
- **Verified on one machine.** `--preflight` exists for exactly this reason; a fresh-machine run
  has not been done.

---

## Tests

```bash
node tests/council.test.mjs     # 55 cases, spends nothing
```

**Every case was demonstrated OPEN before it was closed** — absolute-path traversal, symlink
escape, a private key with no telling suffix, ranking-block spoofing, a duplicate label
outvoting a careful reviewer, prompt injection, a quota message accepted as an answer, and a
SIGTERM-resistant child that held the process open after the run had finished.

---

## Credit

The three-stage shape — answer, rank anonymously, synthesise — is
[karpathy/llm-council](https://github.com/karpathy/llm-council). This is a reimplementation on
local CLIs with measured bias controls; no code was copied.

The revision round is [Mixture-of-Agents](https://arxiv.org/abs/2406.04692). The bias taxonomy
is the LLM-as-a-judge literature, including
[Justice or Prejudice?](https://arxiv.org/abs/2410.02736).

MIT.
