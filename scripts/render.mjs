// The live view — one line per member, redrawn in place, with a clock that moves.
//
// This is what the old run was missing. Stage 1 announced "5 members, in parallel" and then printed
// nothing until a member finished, so the terminal was identical for a council that was working and
// one that had hung. The measurement in `events.mjs` explains why nothing better was possible from
// the members themselves: in plain mode they are buffered, and their first byte arrives at 90–98%
// of the run. **The clock is the honest signal**, and the parent has it for free.
//
// Two rendering modes, and the second one is not a downgrade:
//
//   TTY      an in-place block, redrawn on every event. What a human wants.
//   non-TTY  one append-only line per state change. What CI, a pipe, and a log file want — an
//            in-place redraw written to a file is thousands of lines of escape codes, and a
//            progress bar in CI output is worse than no progress bar.
//
// The same reducer drives both, and drives `watch.mjs` too, so the three cannot drift.

import { reduce } from './events.mjs';
import { up, clearBelow } from './ansi.mjs';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const clock = (ms) => {
  const s = Math.round((ms ?? 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

/**
 * @param out    a writable stream — stderr, so stdout stays the machine-readable path
 * @param isTty  forced for tests; defaults to whatever the stream says
 */
export function createRenderer({ out = process.stderr, isTty = out.isTTY, width = out.columns || 80 } = {}) {
  let state = null;
  let painted = 0;      // lines currently occupied by the live block
  let frame = 0;
  const announced = new Set();   // non-TTY: transitions already logged, so nothing repeats

  const w = (s) => { try { out.write(s); } catch { /* stderr closed; the run continues */ } };

  /** Erase the live block so ordinary output can be written above it. */
  const erase = () => {
    if (!isTty || !painted) return;
    w(up(painted) + clearBelow);
    painted = 0;
  };

  const memberLine = (m) => {
    const pad = (s, n) => String(s).padEnd(n).slice(0, n);
    if (m.state === 'running') {
      const spin = SPIN[frame % SPIN.length];
      // Bytes are shown only once some have arrived. Showing "0 chars" for four minutes — which is
      // what the buffering measurement guarantees — reads as broken rather than as working.
      const got = m.bytes ? ` · ${m.bytes.toLocaleString()} chars in` : '';
      return `  ${spin} ${pad(m.label, 28)} ${clock(m.elapsedMs)}${got}`;
    }
    if (m.state === 'ok') return `  ✅ ${pad(m.label, 28)} ${clock(m.elapsedMs)} · ${(m.chars ?? 0).toLocaleString()} chars`;
    if (m.state === 'failed') return `  ❌ ${pad(m.label, 28)} ${clock(m.elapsedMs)} · ${String(m.reason ?? 'failed').slice(0, 40)}`;
    return `  ·  ${pad(m.label, 28)} queued`;
  };

  /** Repaint the block for the stage currently running. */
  const paint = () => {
    if (!isTty || !state?.stage) return;
    erase();
    const lines = [...state.members.values()]
      .filter((m) => m.state !== 'absent')
      .map(memberLine);
    const running = lines.length ? lines : ['  (waiting)'];
    w(`${running.join('\n')}\n`);
    painted = running.length;
  };

  return {
    /** Print a line of ordinary output without fighting the live block. */
    note(text) {
      erase();
      w(`${text}\n`);
      paint();
    },

    /** Feed one event. Safe to call with a partial or out-of-order stream. */
    handle(e) {
      state = reduce(state, e);
      if (e.ev === 'member_tick') frame++;

      if (isTty) {
        // Stage boundaries and completions deserve a permanent line above the block; everything
        // else is already visible in the block itself.
        if (e.ev === 'stage_start') { erase(); w(`\n▸ Stage ${e.stage} — ${(e.members ?? []).length} member(s)${e.hint ? `, ${e.hint}` : ''}\n`); }
        if (e.ev === 'stage_done') { erase(); painted = 0; }
        paint();
        return;
      }

      // ── non-TTY: append-only, one line per transition, nothing repeated ──
      const once = (key, line) => { if (!announced.has(key)) { announced.add(key); w(`${line}\n`); } };
      switch (e.ev) {
        case 'stage_start':
          once(`s${e.stage}`, `\n▸ Stage ${e.stage} — ${(e.members ?? []).length} member(s)${e.hint ? `, ${e.hint}` : ''}`);
          break;
        case 'member_start':
          once(`b${e.stage}${e.id}`, `  ▹ ${e.label} started (prompt ${(e.promptChars ?? 0).toLocaleString()} chars via ${e.via})`);
          break;
        case 'member_tick': {
          // A once-a-minute line so a CI log shows the run is alive without one line per second.
          // The `>= 60_000` guard matters: the first tick of a stage arrives at ~0ms, and `0 % 60`
          // is 0, so without it every member announced "still running at 0s" the moment it started.
          const secs = Math.round((e.elapsedMs ?? 0) / 1000);
          if (e.elapsedMs >= 60_000 && secs % 60 === 0) {
            once(`t${e.stage}${e.id}${secs}`, `  ⋯ ${e.label ?? e.id} still running at ${clock(e.elapsedMs)}`);
          }
          break;
        }
        case 'member_done':
          w(`  ${e.ok ? '✅' : '❌'} ${e.label ?? e.id} — ${clock(e.ms)}${e.ok ? '' : ` — ${String(e.reason ?? '').slice(0, 60)}`}\n`);
          break;
      }
    },

    /** Leave the terminal in a clean state, whatever happened. */
    finish() { erase(); },

    /** Exposed for `watch.mjs` and the tests. */
    get state() { return state; },
  };
}
