#!/usr/bin/env node
// Watch a council run from outside the process that is running it.
//
//   node scripts/watch.mjs                        # follow the newest run in .council/runs/
//   node scripts/watch.mjs <file.ndjson>          # follow a specific one
//   node scripts/watch.mjs <file.ndjson> --once   # render what is there and exit
//
// ── Why this ships rather than being left as an exercise ──────────────────────────────────
//
// The claim that `--events` makes the run consumable by "a terminal, a VS Code extension, or a web
// page" is easy to write and easy to be wrong about. A stream that only its own author can read —
// because the ordering is implicit, or a field is missing, or state cannot be rebuilt from a
// mid-run attach — is not an integration point, it is a log file with a schema attached.
//
// So this is a **second, independent consumer**, in a separate process, with no access to the
// council's memory. Everything it shows it rebuilt from the file. If a field is missing from the
// stream this cannot render it either, which is the point: the gap shows up here instead of in
// somebody's extension three weeks later.
//
// It shares exactly one thing with the live view: `reduce()` from `events.mjs`. That is deliberate —
// the reducer is the contract, and an extension author should use it rather than reimplement it.
//
// **Attaching late must work**, because that is the normal case. A run started twenty minutes ago
// in another terminal is precisely when someone wants to look, so the whole file is replayed before
// following, and the rendered state is correct rather than partial.

import fs from 'node:fs';
import path from 'node:path';
import { reduce } from './events.mjs';
import { createRenderer } from './render.mjs';

const argv = process.argv.slice(2);
const once = argv.includes('--once');
let file = argv.find((a) => !a.startsWith('--'));

// Newest events file under .council/runs/, so the common case needs no argument. A user who has to
// paste a path to see progress will not look.
if (!file) {
  const dir = path.join(process.cwd(), '.council', 'runs');
  try {
    const found = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.events.ndjson'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    file = found[0]?.f;
  } catch { /* no runs directory yet */ }
}

if (!file) {
  process.stderr.write('\n  No event stream to watch.\n\n'
    + '  A council only writes one when asked:\n'
    + '      node scripts/council.mjs "<question>" --context <file> --events\n\n'
    + '  Then, in another terminal:\n'
    + '      node scripts/watch.mjs\n\n');
  process.exit(2);
}

if (!fs.existsSync(file)) {
  process.stderr.write(`\n  ${file} does not exist yet.\n\n`);
  process.exit(2);
}

const render = createRenderer();
let offset = 0;
let carry = '';          // a tail that arrived without its newline — never parse a partial line
let finished = false;

/**
 * Read whatever has been appended since last time.
 *
 * A file being appended to is read at a byte offset rather than re-read whole: a 20-minute run
 * writes thousands of events, and re-parsing all of them every 250 ms to find the new one is the
 * kind of thing that works in testing and pegs a core in practice.
 */
function drain() {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }

  // Truncated or replaced underneath us — a new run reusing the slug. Start over rather than
  // reading from an offset that now points into the middle of a different line.
  if (size < offset) { offset = 0; carry = ''; }
  if (size === offset) return;

  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    offset = size;
    const lines = (carry + buf.toString('utf8')).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      // A malformed line is skipped, not fatal. This is a viewer; it must never be the reason a
      // user cannot see a run.
      try { e = JSON.parse(line); } catch { continue; }
      render.handle(e);
      if (e.ev === 'run_done' || e.ev === 'run_error') finished = true;
    }
  } finally { fs.closeSync(fd); }
}

drain();

if (once || finished) {
  render.finish();
  summarise();
  process.exit(0);
}

render.note(`\n▸ Watching ${path.relative(process.cwd(), file)} — Ctrl-C to stop following (the run continues)\n`);

// Polling rather than fs.watch: fs.watch's append notifications are unreliable across platforms and
// network filesystems, and a viewer that misses events is worse than one that is 250 ms behind.
const timer = setInterval(() => {
  drain();
  if (finished) { clearInterval(timer); render.finish(); summarise(); process.exit(0); }
}, 250);

process.on('SIGINT', () => {
  clearInterval(timer);
  render.finish();
  process.stderr.write('\n  Stopped watching. The council is still running.\n\n');
  process.exit(0);
});

function summarise() {
  const s = render.state;
  if (!s) return;
  const done = s.done;
  process.stderr.write(`\n${'─'.repeat(64)}\n`);
  if (s.error) { process.stderr.write(`  The run failed: ${s.error}\n\n`); return; }
  if (!done) { process.stderr.write('  The stream ends without a run_done — the council was killed, or is still writing.\n\n'); return; }
  process.stderr.write(`  ${done.answered}/${done.requested} answered.\n`);
  if (done.file) process.stderr.write(`  ▸ ${done.file}\n`);
  process.stderr.write('\n');
}
