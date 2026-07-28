# Contributing

The most valuable contribution to this repo is **a measurement**, not a feature.

## The one experiment this needs most

**Nobody has measured whether a council answer beats one top-tier model.** The premise is
borrowed from [Mixture-of-Agents](https://arxiv.org/abs/2406.04692) and has never been tested
on real engineering questions.

The experiment is about half a day:

1. Pick 10 hard questions from a real codebase — ones with a knowable right answer.
2. Answer 5 through the council, 5 through a single top-tier model.
3. Have someone judge them **blind** — no labels, shuffled.
4. Report the result **whichever way it comes out**, including "no difference".

A null result is worth as much as a positive one and will be merged with the same enthusiasm.
If a council does not beat one model on your questions, that is the single most useful thing
anyone could tell users of this repo.

## Other measurements worth having

- **Bias numbers at real n.** Self-enhancement is measured at n=4 and n=5. Run 30.
- **Does `--revise` help or homogenise?** Measured once: cross-member similarity went 0.08 →
  0.07, so it deepened answers without converging them. n=1.
- **The context ceiling on other models.** Ours: at ~80k, Gemini 3.1 Pro stopped following the
  instruction while still accepting the payload. Where does yours break?
- **Fresh-machine install.** Verified on exactly one Mac.

## Adding a member

`scripts/members.json`. Every entry must carry:

- a **read-only** mode — members advise, never edit
- a `{prompt}` placeholder
- a `verified` date, and **you must actually have run it**

Then `node tests/council.test.mjs`.

## Code

Two rules, both from being wrong repeatedly:

**1 · Write the false-positive case before writing the check.** Every control in this repo was
wrong on its first version, and every one was caught by testing the case it should have been
*silent* on — never by the case it was built to catch.

**2 · A check that cannot evaluate its input must refuse, never pass.** Three separate bugs
here were the same shape: failing open, silently, in a way that read as success.

## Tests

```bash
node tests/council.test.mjs     # 151 cases, spends nothing
```

**Every case must be demonstrated OPEN before it is closed.** If you fix something, show the
test failing first. A test written after the fix proves the fix compiles, not that it works.

## What will be declined

- **A retry loop.** A missing CLI will still be missing in thirty seconds and an exhausted
  quota does not refill while you wait. Retrying converts a clear answer into a hang.
- **Giving members repo access.** Read-only in these CLIs means *cannot write*, not *cannot
  read*. A member with repo access can read your `.env`.
- **A chairman subprocess.** Stage 3 is deliberately yours — a synthesis written by a pipe has
  lost the conversation that made the question worth asking.
- **Removing the bias diagnostics.** They exist to make the score harder to quote.
