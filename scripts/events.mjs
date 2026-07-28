// The event stream — one NDJSON line per thing that happened, as it happens.
//
// WHY THIS EXISTS, and why it is a stream rather than a nicer progress bar.
//
// A council run is 10–30 minutes. For all of it the old version printed nothing between
// `▸ Stage 1 — 5 members, in parallel` and the first member finishing, because it logged on
// COMPLETION. A user who looked away could not distinguish "four models are thinking" from
// "this has hung", which is the single most common reason someone kills a run that was working.
//
// The obvious fix is to relay the members' own output as it arrives. **That was measured and it
// does not work.** Probed 2026-07-28, asking each CLI for 40 lines of output and timestamping
// every chunk on stdout:
//
//   CLI      chunks   first byte      spread over the run
//   codex        1    14.8s of 15.1s   0%     ← one buffered dump at the end
//   claude       1    24.7s of 25.2s   0%     ← one buffered dump at the end
//   agy          1    13.4s of 14.8s   0%     ← one buffered dump at the end
//   grok        77    11.7s of 12.9s   7%     ← silent for 90%, then streams fast
//
// **In plain mode every member is effectively buffered.** The first byte lands at 90–98% of the
// run, so byte-level progress tells you a member is nearly done about one second before it is
// done. Relaying child output is not a progress indicator; it is a completion notice with extra
// steps. (`claude --output-format stream-json` IS genuinely incremental — first event at 348ms,
// spread across 92% of the run — but it is the only one, and switching the answer path to a
// per-vendor JSON schema to get it would trade a proven path for a fragile one. Recorded in the
// roadmap as a measurement, not adopted.)
//
// So progress is emitted by the PARENT, which needs no cooperation from anyone: it knows who
// started, when, and that they have not finished yet. Elapsed time per member, live, is the
// information the user actually wants — *is it alive, and how long has it been* — and it is
// available for free.
//
// The stream is NDJSON on purpose. One line, one event, append-only, no framing to get wrong.
// A terminal renderer, a VS Code extension, a web page tailing the file, or `jq` all consume the
// same bytes, so no surface has privileged access to the run. `scripts/watch.mjs` is a working
// consumer and exists mainly to prove that claim.
//
// **Nothing in an event carries prompt or file content.** Counts, ids, durations, states — never
// the pack. The pack is repo source; a run log that quietly contains it is the leak this project
// spends `context.mjs` preventing, one layer up. `lastLine` is the sole exception and it is
// capped and scrubbed by `redactLine` below.

import fs from 'node:fs';
import path from 'node:path';

/** Bump when a field changes meaning. A consumer that cannot read this must say so, not guess. */
export const SCHEMA = 1;

/**
 * Every event name the stream can emit, with what a consumer can rely on.
 *
 * Exported so `watch.mjs` and the tests check against one list rather than three copies, and so
 * an extension author has something to read that is not this comment.
 */
export const EVENTS = {
  run_start:    'schema, question, members[], flags{}  — always first',
  preflight:    'available[], absent[]                 — who is here, before anything is spent',
  context:      'files[], refused[], chars, tokens, budgetTokens, briefSource',
  stage_start:  'stage, members[]',
  member_start: 'stage, id, label, promptChars, via',
  member_tick:  'stage, id, elapsedMs, bytes, lastLine — heartbeat; the parent, not the child',
  member_done:  'stage, id, ok, ms, chars, reason?',
  stage_done:   'stage, ok, failed',
  tally:        'scores{}, diagnostics{}',
  run_done:     'ok, answered, requested, file, exitCode  — always last',
  run_error:    'message                                 — the run died; no run_done follows',
};

/**
 * A status line can echo whatever the child printed, and a child can print anything — including
 * a fragment of the pack it was just given. Capped hard and stripped of anything shaped like a
 * credential before it goes anywhere a UI might persist it.
 */
// Built with String.fromCharCode rather than written as a literal range, because the literal
// version put a real NUL byte in this file — and this file gets passed to councils as context.
// A control byte in source is invisible in review and breaks something far away from itself.
const CONTROL_CHARS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g');

export function redactLine(s, max = 120) {
  return String(s ?? '')
    .replace(CONTROL_CHARS, ' ')                       // control chars, incl. ANSI leftovers
    .replace(/\b(sk-|ghp_|gho_|ghu_|ghs_|ghr_|AC)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[redacted]')
    .trim()
    .slice(0, max);
}

/**
 * Open an emitter. Both sinks are optional and independent:
 *
 *   file      an NDJSON file to append to — what a UI tails
 *   toFd      a file descriptor to also write to (3 for `--json-events`), so a parent process
 *             can consume the stream without a file and without colliding with stderr, which
 *             the human-readable renderer owns
 *
 * **Emitting must never be able to break a run.** A full disk, a closed pipe, a reader that went
 * away mid-run — none of those are reasons to lose a 20-minute council, so every write is
 * swallowed. The stream is telemetry; the run is the product.
 */
export function createEmitter({ file = null, toFd = null } = {}) {
  const t0 = Date.now();
  let fd = null;
  let broken = null;


  if (file) {
    try {
      // WAS OPEN: this computed the directory with a regex that requires a slash, so
      // `--events=run.ndjson` produced "run.ndjson" as the DIRECTORY name, created it, and then
      // failed to open the file — with --events treated as fatal, the run refused to start at all.
      // path.dirname returns "." for a bare filename, which is what was meant.
      fs.mkdirSync(path.dirname(file), { recursive: true });

      // `'w'`, not `'a'`. **One file is one run.**
      //
      // Appending was the intuitive choice and it was wrong. A re-run against the same slug produced
      // a file containing two `run_start` events, two sets of members and two `run_done`s — and
      // `reduce()` folds them into one incoherent state, because a stream is defined as one run from
      // start to finish. Truncating also gives a watcher a clean signal: `watch.mjs` sees the file
      // shrink below its read offset and starts over, which is exactly right for a new run.
      // O_NOFOLLOW, matching safe-write.mjs. This was the third output file and the only one still
      // opened with a plain 'w' — so the check/open race that safe-write closes for the .md and the
      // .json stayed open for the stream, which is also the file that exists longest.
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
        | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
    } catch (e) { broken = e.message; }
  }

  // A sink that cannot be written to AT ALL is a different fact from one that fails mid-run, and
  // --events already treats the first as fatal. --json-events did not: an unopenable fd 3 was
  // swallowed, so a parent that asked for the stream got silence and no way to tell it from a council
  // still thinking. The package's own rule — "asked for and not delivered is a failure, not a
  // detail" — was applied to one sink and not the other.
  if (toFd !== null && broken === null) {
    try { fs.writeSync(toFd, ''); } catch (e) { broken = `fd ${toFd} is not writable: ${e.message}`; }
  }

  const write = (line) => {
    if (fd !== null) { try { fs.writeSync(fd, line); } catch { /* telemetry, not the product */ } }
    if (toFd !== null) { try { fs.writeSync(toFd, line); } catch { /* reader went away mid-run */ } }
  };

  return {
    file,
    /** Whether a sink actually opened — surfaced so `--events` can fail loudly instead of silently. */
    broken,
    emit(ev, data = {}) {
      write(`${JSON.stringify({ t: Date.now() - t0, ts: new Date().toISOString(), ev, ...data })}\n`);
    },
    close() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } fd = null; } },
  };
}

/**
 * Fold a stream of events into the state a renderer needs. Pure, so the terminal renderer, the
 * file watcher and the tests all agree by construction rather than by review.
 *
 * Deliberately tolerant of a truncated stream: a UI attached halfway through a run, or reading a
 * file still being written, gets a partial but coherent picture rather than a crash.
 */
export function reduce(state, e) {
  const s = state ?? {
    schema: null, question: null, members: new Map(), absent: [], context: null,
    brief: null, stage: null, tally: null, done: null, error: null, lastT: 0,
  };
  s.lastT = e.t ?? s.lastT;

  switch (e.ev) {
    case 'run_start':
      s.schema = e.schema; s.question = e.question; s.flags = e.flags ?? {};
      for (const m of e.members ?? []) s.members.set(m.id, { ...m, state: 'waiting' });
      break;
    case 'preflight':
      s.absent = e.absent ?? [];
      // Mark them, so the renderer's `state !== 'absent'` filter has something to filter on. It
      // never did: an uninstalled member sat at "queued" for the entire run, next to members that
      // really were about to answer.
      for (const m of s.absent) {
        const known = s.members.get(m.id);
        if (known) known.state = 'absent';
        else s.members.set(m.id, { ...m, state: 'absent' });
      }
      break;
    case 'context':
      s.context = { files: e.files ?? [], refused: e.refused ?? [], tokens: e.tokens, budgetTokens: e.budgetTokens };
      s.brief = e.briefSource ?? null;
      break;
    case 'stage_start':
      s.stage = e.stage;
      for (const id of e.members ?? []) {
        const m = s.members.get(id);
        if (m) Object.assign(m, { state: 'waiting', elapsedMs: 0, bytes: 0, lastLine: '' });
      }
      break;
    case 'member_start': {
      const m = s.members.get(e.id) ?? { id: e.id, label: e.label };
      Object.assign(m, { state: 'running', elapsedMs: 0, bytes: 0, via: e.via, promptChars: e.promptChars });
      s.members.set(e.id, m);
      break;
    }
    case 'member_tick': {
      const m = s.members.get(e.id);
      if (m) Object.assign(m, { state: 'running', elapsedMs: e.elapsedMs, bytes: e.bytes, lastLine: e.lastLine ?? '' });
      break;
    }
    case 'member_done': {
      const m = s.members.get(e.id);
      if (m) Object.assign(m, { state: e.ok ? 'ok' : 'failed', elapsedMs: e.ms, chars: e.chars, reason: e.reason });
      break;
    }
    case 'tally':   s.tally = e; break;
    case 'run_done': s.done = e; s.stage = null; break;
    case 'run_error': s.error = e.message; break;
  }
  return s;
}
