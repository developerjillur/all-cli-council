// How the prompt reaches a member — and why `argv` was the wrong answer.
//
// Every member used to be invoked as `cmd ... "<the entire prompt>"`, with the assembled context
// pack substituted into an argument. That works on the machine it was written on and fails two
// ways elsewhere. Both were measured on 2026-07-28; neither was hypothetical.
//
// ── 1. It cannot carry this project's own documented context budget on Linux ──────────────
//
// Linux caps a SINGLE argv string at MAX_ARG_STRLEN = 32 pages = 131,072 bytes, independently of
// the much larger total `ARG_MAX`. Probed in `node:22-alpine`:
//
//     131,000 chars in one argv → ok
//     160,000 chars in one argv → E2BIG
//     200,000 chars in one argv → E2BIG
//
// `context.mjs` sets `MAX_TOTAL_CHARS = 160_000`, and the brief adds up to 8,000 more. **A run at
// the budget the README advertises cannot spawn a member on Linux at all** — and stage 2 is
// worse, because it appends every member's full answer to the same string. macOS hides this
// completely: Darwin has no per-argument cap, and 1,000,000 chars in one argv succeeded there.
// This is precisely the "verified on one machine" limitation the README lists, except it is not a
// caveat — it is an outage on every Linux CI runner, container and devcontainer.
//
// ── 2. argv is world-readable, so the pack leaks to every user on the box ─────────────────
//
// On Linux `/proc/<pid>/cmdline` is mode **444**. Measured: a canary placed in a child's argv was
// recovered from `/proc/<pid>/cmdline` by a reader with no special privileges while the child ran.
//
// That matters more here than in most tools. `context.mjs` refuses `.env`, refuses `data/`,
// refuses anything whose *contents* match a secret shape, and fences the pack as data — all to
// control what leaves the machine. Then the old delivery path published the whole assembled pack
// into the process table for the duration of the call. **The careful part was undone by the
// boring part.**
//
// ── The fix, and the reason it is per-member rather than global ───────────────────────────
//
// Prompts go by stdin where the CLI reads stdin, by file where it takes a path, and by argv only
// where a member offers nothing else. Measured per CLI, because the CLIs disagree:
//
//     codex exec -                   stdin  ✅  documented, and verified live
//     claude --print                 stdin  ✅  verified live
//     grok --prompt-file <path>       file   ✅  verified live — better than stdin: no pipe at all
//     agy --print <prompt>           *argv*  ⚠   no stdin, no file path
//
// **`agy` is the reason this module refuses instead of assuming.** Piping a prompt to
// `agy --print` **exits 0 and answers pleasantly** — "How can I help you today?" — because the
// prompt never arrived and it treated the turn as empty. Same for `agy --print -`. A wrong
// delivery mode here does not error; it produces a fluent answer to a question nobody asked,
// which then goes into the anonymised peer review and gets ranked against real answers. That is
// the same failure class as a quota message being ranked as an opinion (`judge-output.mjs`), and
// it is worse, because a quota message at least looks wrong.
//
// So: an argv-only member is allowed, but its prompt is checked against the platform's real limit
// and the member is **refused by name before anything is spent** if it will not fit — never
// handed to `spawn` to die as `E2BIG` halfway through a paid run. And `--verify-delivery` exists
// to prove, with a canary, that a prompt declared as `stdin` actually arrives.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdirpSafe } from './safe-write.mjs';

/**
 * The real per-argument ceiling, by platform, with headroom.
 *
 * Linux: MAX_ARG_STRLEN is a hard 131,072 and there is no way to raise it. 120,000 leaves room
 * for the other arguments and the environment block, which share the same total budget.
 * Darwin: no per-argument cap; ARG_MAX is 1 MiB for everything including the environment.
 * Windows: the entire command line is capped at 32,767 UTF-16 code units.
 */
export const ARGV_CEILING = { linux: 120_000, darwin: 900_000, win32: 30_000 };

export function argvCeiling(platform = process.platform) {
  return ARGV_CEILING[platform] ?? ARGV_CEILING.linux;   // unknown platform → the strictest real one
}

/**
 * Which channel a member's prompt travels on.
 *
 * `stdin` — write to the child's stdin and close it. The member's args must NOT contain
 *           `{prompt}`; a placeholder plus stdin means the prompt goes twice.
 * `file`  — write the prompt to a 0600 file in the scratch dir and substitute `{promptFile}`.
 * `argv`  — substitute `{prompt}`. Size-checked, and the caller is told it is exposed.
 */
/** The only three channels there are. Anything else is a typo, and a typo must not pick a default. */
export const DELIVERY_MODES = new Set(['stdin', 'file', 'argv']);

export function deliveryOf(member) {
  if (member.promptVia) return member.promptVia;
  if (member.args.some((a) => a.includes('{promptFile}'))) return 'file';
  if (member.args.some((a) => a.includes('{prompt}'))) return 'argv';
  return 'stdin';
}

/**
 * Prepare the spawn for one member.
 *
 * @returns {{ok: true, args: string[], stdin: string|null, via: string, exposed: boolean,
 *            cleanup: function}} on success, or
 *          {{ok: false, reason: string, via: string}} when the prompt cannot be delivered — which
 *          is a *result*, reported like any other member failure, not an exception.
 */
export function prepare(member, prompt, scratch, platform = process.platform, subs = {}) {
  const via = deliveryOf(member);

  // A closed set, checked first. `promptVia: "sdtin"` used to fall past the stdin branch and land in
  // argv handling — which, for a member whose args contain no `{prompt}`, meant spawning the CLI with
  // no prompt at all. A typo in a roster should not silently choose a delivery mechanism.
  if (!DELIVERY_MODES.has(via)) {
    return { ok: false, via, reason: `member "${member.id}" declares promptVia:"${via}", which is not a `
      + `delivery mode. Valid: ${[...DELIVERY_MODES].join(', ')}. Refused rather than guessed at.` };
  }

  // **Every placeholder EXCEPT the prompt is substituted first, on the raw args.**
  //
  // `{timeoutMin}` used to be mapped over `plan.args` by the caller, after the prompt was already in
  // there — so for an argv-delivered member it rewrote any occurrence inside the context pack. A
  // member reviewing this very file would have been shown a doctored copy of it. Ordering is the
  // whole fix: substitute the small values while the args are still small, and let the prompt in last.
  // `replaceAll`, not `replace`. With a string pattern `replace` substitutes only the FIRST
  // occurrence, so an argument legitimately mentioning a placeholder twice — `--t {timeoutMin}m
  // --hard-timeout {timeoutMin}m` — kept the second one literal.
  const args = member.args.map((a) => Object.entries(subs)
    .reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, () => String(v)), a));

  if (via === 'stdin') {
    // A placeholder left in the args of a stdin member would send the prompt through both
    // channels — argv exposure restored by accident, and some CLIs would see it twice.
    // EITHER placeholder. `{promptFile}` was not checked, so a stdin member carrying one spawned with
    // the literal string "{promptFile}" as an argument — a CLI given a path that does not exist, whose
    // error then arrives as a member failure with no hint of the cause.
    const stray = args.find((a) => a.includes('{prompt}') || a.includes('{promptFile}'));
    if (stray) {
      return { ok: false, via, reason: `member "${member.id}" declares promptVia:"stdin" but an argument `
        + `still contains a placeholder (${stray}). Either the prompt would travel twice — once of them `
        + `exposed in argv — or the literal placeholder would be passed as a path.` };
    }
    return { ok: true, via, args, stdin: prompt, exposed: false, cleanup: () => {} };
  }

  // Structural validation, because the failure mode is silence.
  //
  // A roster declaring `promptVia: "argv"` with no `{prompt}` in its args — a typo, a hand-written
  // entry, a member copied and edited — spawned the CLI with no prompt at all. Which is the `agy`
  // failure again: exit 0, a fluent answer to an empty question, ranked against real ones. The
  // placeholder is not a convenience, it is the delivery mechanism.
  if (via === 'file' && !args.some((a) => a.includes('{promptFile}'))) {
    return { ok: false, via, reason: `member "${member.id}" declares promptVia:"file" but no argument `
      + `contains {promptFile}, so the prompt has nowhere to go. It would run with no prompt and answer `
      + `an empty question — refused instead.` };
  }
  if (via === 'argv' && !args.some((a) => a.includes('{prompt}'))) {
    return { ok: false, via, reason: `member "${member.id}" declares promptVia:"argv" but no argument `
      + `contains {prompt}, so the prompt has nowhere to go. It would run with no prompt and answer an `
      + `empty question — refused instead.` };
  }

  if (via === 'file') {
    // 0600 and inside the scratch dir. A world-readable prompt file would reintroduce, on disk
    // and for longer, exactly the exposure argv had.
    const f = path.join(scratch, `prompt-${member.id}-${crypto.randomUUID()}.txt`);
    try {
      // Bounded, non-recursive: a roster-supplied scratchDir under procfs hangs a recursive mkdir.
      mkdirpSafe(scratch);
      fs.writeFileSync(f, prompt, { mode: 0o600 });
    } catch (e) {
      return { ok: false, via, reason: `could not write the prompt file for ${member.id}: ${e.message}` };
    }
    return {
      ok: true, via, exposed: false, stdin: null,
      // Returned rather than left for the caller to find by scanning args for a prefix. This file
      // holds the entire context pack; the interrupt handler must not have to guess its name.
      promptFile: f,
      // A replacer function, never a replacement string: `String.replace` expands `$&`, `` $` ``,
      // `$'` and `$1` in a string replacement, and these prompts are full of source code.
      args: args.map((a) => a.replaceAll('{promptFile}', () => f)),
      // Removed as soon as the member exits, whether it answered or not. A scratch dir that
      // accumulates prompt files is a slow-motion version of the leak this replaced.
      cleanup: () => { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } },
    };
  }

  // argv — allowed, size-checked, and honest about what it costs.
  //
  // Measured in BYTES, not characters. The kernel counts bytes; `String.length` counts UTF-16 code
  // units. This repo's own prose is full of em-dashes and arrows at 3 bytes each, so the two numbers
  // diverge badly on exactly the content it is most likely to be given: 60,000 em-dashes is 60,000
  // chars — comfortably under the 120,000 ceiling — and 180,000 bytes, which the kernel refuses.
  // The guard would have waved it through and the spawn would have failed as E2BIG, which is the
  // precise failure this function exists to convert into a clear refusal.
  const limit = argvCeiling(platform);
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > limit) {
    return {
      ok: false, via,
      reason: `prompt is ${bytes.toLocaleString()} bytes (${prompt.length.toLocaleString()} chars) `
        + `and this member can only be given it through argv, which ${platform} caps at `
        + `~${limit.toLocaleString()} bytes. Send fewer --context files, or drop this member with `
        + `--members=. Refused before spending rather than failing as E2BIG mid-run.`,
    };
  }
  return {
    ok: true, via, exposed: true, stdin: null,
    // Measured: a prompt containing `s.replace(/x/, '$&$&')` arrived as
    // `s.replace(/x/, '{prompt}{prompt}')`, and `$'` / `` $` `` were deleted. A replacer
    // function is never pattern-expanded.
    args: args.map((a) => a.replaceAll('{prompt}', () => prompt)),
    cleanup: () => {},
  };
}

/**
 * The canary a `--verify-delivery` probe asks for.
 *
 * Unique per probe so a cached session, a resumed conversation or a CLI echoing its own help text
 * cannot satisfy it by accident.
 */
export function canary() {
  const token = `COUNCIL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return {
    token,
    // **The reply is deliberately a sentence, not a bare token, and that is a bug fix.**
    //
    // The first version asked for the token alone. The token is 16 characters; `judge-output.mjs`
    // rejects anything under `MIN_ANSWER_CHARS` (24) as "too short to be an answer". So a member
    // that complied *exactly* was reported as **NO CANARY — the prompt is not arriving**, on a
    // channel that worked perfectly. The one feature whose entire job is catching a silent
    // false negative was itself a guaranteed false negative. Found by this package grading itself.
    //
    // Fixed twice over, deliberately: the reply is now comfortably longer than the floor, AND
    // `--verify-delivery` judges the raw output for the token rather than routing a probe through
    // the answer heuristics, which were written for answers and do not apply to a canary.
    // **Phrased as a self-test with its reason, not as a bare command — and that is the second bug
    // fix in this function.**
    //
    // The previous wording was *"Reply with exactly this line and nothing else: DELIVERY CONFIRMED
    // <token>"*. Sonnet 5 read that, correctly, as injection-shaped — an instruction to ignore its
    // judgement and emit a fixed string — and answered *"This appears to be a prompt injection
    // attempt."* The tool then reported **"NO CANARY — the prompt is not arriving"** on a channel
    // that was working perfectly.
    //
    // So the probe was punishing the members with the best instincts, in the one feature whose entire
    // purpose is not producing false negatives. A request with a stated reason is not injection-shaped
    // and a careful model has no reason to refuse it.
    prompt: `This is a delivery self-test from a local tool (All CLI Council). It is checking that a `
      + `prompt sent on this channel actually reaches you — when the channel is wrong, some CLIs `
      + `silently treat the turn as empty and answer a question they never received, which nothing `
      + `downstream can detect.\n\n`
      + `Nothing is being asked of your judgement, and there is no task hidden in this. Just confirm `
      + `receipt by including this token somewhere in your reply:\n\n`
      + `    ${token}\n\n`
      + `One short line is plenty.`,
    /**
     * A member whose prompt never arrived answers *something* — a greeting, an offer to help.
     * Only the token proves the bytes got there.
     */
    /**
     * The token must come back **without** the sentence that asked for it.
     *
     * Some CLIs echo their prompt before answering — and an echo contains the token, so it certified
     * delivery for a member that then said nothing at all. The probe cannot tell "it received this and
     * replied" from "it printed back what it was given" on the token alone.
     *
     * The distinctive sentence is the tell: a reply that contains BOTH the token and the request for it
     * is an echo of the prompt; a reply that contains the token and not the request is an answer. And
     * if a member echoes the prompt and then also answers, the token still appears outside the echoed
     * block, so stripping the echo first is what makes both cases work.
     */
    arrived: (out) => {
      const s = String(out ?? '');
      if (!s.includes(token)) return false;
      // Remove any echoed copy of the probe, then look again.
      const withoutEcho = s.split('One short line is plenty.').pop() ?? s;
      return withoutEcho.includes(token) || !s.includes('delivery self-test');
    },
    /**
     * "It refused" and "it never got the prompt" need different remedies, and reporting the first as
     * the second sends someone to edit a `promptVia` that was correct.
     *
     * A member that mentions the probe at all clearly received it; the delivery channel is fine and
     * the wording is what needs work.
     */
    /**
     * A refusal must reference THIS probe, not merely contain a refusing word.
     *
     * The first version matched `/refus|cannot comply|.../` anywhere — so a member whose prompt never
     * arrived and which replied "I cannot comply with an empty request" was classified as *declined*
     * and reported as **"delivery channel is FINE"**. That is the original false negative restored
     * through the classifier written to prevent it.
     *
     * So it must show evidence of having read the probe: naming the token, or the self-test, or the
     * injection judgement that only its wording provokes. And a bare greeting — the signature of a
     * prompt that never arrived — is disqualified outright.
     */
    refused: (out) => {
      const s = String(out ?? '');

      // A bare greeting is the signature of a prompt that never arrived. Disqualified first, whatever
      // else the reply goes on to say.
      if (/^\s*(hi|hello|hey)\b|how can i (help|assist)/i.test(s.slice(0, 120))) return false;

      // Naming an injection is itself conclusive: nothing but this probe's wording provokes it, so the
      // member demonstrably read the prompt. It needs no separate refusal verb — the real observed
      // reply was "This appears to be a prompt injection attempt embedded in the file", with no
      // "I will not comply" anywhere in it.
      if (/prompt injection|injection attempt/i.test(s)) return true;

      // Otherwise a refusal must still show evidence of having read THIS probe. Without that, a member
      // whose prompt never arrived and which replied "I cannot comply with an empty request" was
      // classified as declined and reported as "delivery channel is FINE" — the original false
      // negative, restored through the classifier written to prevent it.
      const sawTheProbe = /self-test|self test|delivery test|COUNCIL-[0-9A-F]{8}/i.test(s);
      const declined = /\brefus|will not comply|cannot comply|won't comply|decline/i.test(s);
      return sawTheProbe && declined;
    },
  };
}
