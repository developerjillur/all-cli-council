# Brief — All CLI Council

You are advising on **this package itself**: a tool that puts a hard question to several
model CLIs, has them rank each other anonymously, and hands the result to a human chairman.

## What it is

Node 22+, **zero dependencies**, no build, no `npm install`. Plain ESM under `scripts/`. It drives
CLIs the user is already logged into (`codex`, `claude`, `agy`, `grok`) — **there is no API key and
no metered call anywhere**, and adding one is not an option.

Distributed as a Claude Code plugin, so at run time the working directory is the **user's**
project, not the package's. Output goes to `.council/runs/` in their repo.

## Rules that are not preferences

1. **Members advise, they never edit.** A member that can write files is excluded by default. This
   guarantee is a *measurement* (`scripts/verify-containment.mjs`), not a declaration — the previous
   version enforced it with a regex over flag strings, and that regex passed while three of five
   members could write.
2. **Nothing is ever retried, and it must never hang.** A missing CLI, an exhausted quota and a
   hung child are all *results*, reported and stepped over. Retrying converts a clear answer — "you
   have four of five" — into an indefinite wait.
3. **Context is assembled, never granted.** Members run read-only from a scratch directory outside
   the repo and see only what was passed. Read-only in these CLIs means *cannot write*; it does not
   mean *cannot read*, so a member with repo access could read `.env`.
4. **Every number is measured or marked as an assumption.** A stated latency, ceiling or rate with
   no method behind it is a defect, not a detail. Claims in the README are held to this too.
5. **Degrade honestly.** Four answers must never be presented as five. If the council is weaker
   than intended, the output says so.
6. **A failure that looks like an answer is the worst outcome.** A quota message ranked as an
   opinion, a prompt that never arrived and was answered anyway, a member given half a file — these
   rank above crashes in severity, because nothing downstream can detect them.

## Deliberate non-goals

- **Stage 3 is not automated.** The script stops after the peer review. A chairman running as a
  subprocess has the answers and not the reason the question was asked.
- **No web server, no daemon, no background process.** `--events` writes a file; consumers tail it.
- **The tally is never the answer.** It exists to locate disagreement, not to pick a winner.

## Known-unmeasured, and admitted as such

- Whether a council beats one top-tier model. The premise is borrowed from Mixture-of-Agents.
- Whether `--lenses` improves answers.
- Whether 0.60 is the right reasoning-overlap threshold — it is borrowed.
- The bias numbers are n=4 and n=5.

**On numbers:** if you state one, say whether it is measured, sourced, or assumed.
