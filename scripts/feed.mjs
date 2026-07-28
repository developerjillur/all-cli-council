#!/usr/bin/env node
// One line per thing worth being told about, until the run ends. Built for a supervising agent.
//
//   node scripts/feed.mjs                    # follow the newest run
//   node scripts/feed.mjs <file.ndjson>      # a specific one
//   node scripts/feed.mjs --every=30         # heartbeat cadence in seconds (default 60)
//   node scripts/feed.mjs --quiet-after=180  # call it dead after this much silence with no pid
//
// ── What this is for, and why it is not watch.mjs ──────────────────────────────────────────
//
// `watch.mjs` paints a live picture for a human who is looking at it. This emits **discrete lines for
// something that is not looking** — a supervising agent, a notifier, a chat integration. Every line is
// one notification, so the whole design question is *what deserves to interrupt someone*.
//
// The answer is: stage boundaries, each member finishing, the tally, and the end. Not `member_tick` —
// that fires every second, and a thousand notifications is the same as none.
//
// ── The two rules that make it trustworthy ─────────────────────────────────────────────────
//
// **1. Silence must never be able to look like success.** A feed that only reports good news is worse
// than no feed: a crashed run and a thinking run both produce nothing, and the reader cannot tell. So
// there is a heartbeat on a fixed cadence, and a death check — if the pid is gone and no terminal event
// arrived, that is a LINE and a non-zero exit, not a quiet stop.
//
// **2. Attaching late must not flood.** A run twenty minutes old has hundreds of events. Replaying them
// as notifications would be useless. The backlog is folded into ONE catch-up line, and only genuinely
// new events stream after that.
//
// Exit code says how it ended, so a supervisor can branch without parsing:
//
//     0  the run finished           1  it failed
//     2  nothing to follow          4  it died without finishing

import fs from 'node:fs';
import path from 'node:path';
import { reduce } from './events.mjs';

const argv = process.argv.slice(2);
const num = (n, d) => {
  const v = Number(argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
const everyMs = num('every', 60) * 1000;
const quietDeadMs = num('quiet-after', 180) * 1000;
let file = argv.find((a) => !a.startsWith('--'));

if (!file) {
  const dir = path.join(process.cwd(), '.council', 'runs');
  try {
    file = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.events.ndjson'))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f;
  } catch { /* no runs directory yet */ }
}

/** Each line is one notification. Flushed immediately — a buffered feed is not a feed. */
const say = (s) => { try { fs.writeSync(1, `${s}\n`); } catch { /* reader went away */ } };

if (!file || !fs.existsSync(file)) {
  say('no council run to follow — start one with --events (or --detach)');
  process.exit(2);
}

const clock = (ms) => {
  const sec = Math.round((ms ?? 0) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
};

let state = null;
let offset = 0;
let carry = '';
let pid = null;
let startedAt = Date.now();
let lastGrowth = Date.now();
let ended = null;          // 'finished' | 'failed'
let firstPass = true;

/** Read whatever was appended, fold it, and return the events that are new to us. */
function drain() {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  if (size < offset) { offset = 0; carry = ''; state = null; }   // truncated: a new run reused the slug
  if (size === offset) return [];
  lastGrowth = Date.now();

  const fd = fs.openSync(file, 'r');
  const fresh = [];
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    offset = size;
    const lines = (carry + buf.toString('utf8')).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      state = reduce(state, e);
      if (e.ev === 'run_start') { pid = e.pid ?? null; startedAt = Date.now() - (e.t ?? 0); }
      if (e.ev === 'run_done') ended = 'finished';
      if (e.ev === 'run_error') ended = 'failed';
      fresh.push(e);
    }
  } finally { fs.closeSync(fd); }
  return fresh;
}

/** One line describing what a member's completion means. */
const memberLine = (e) => `${e.ok ? '✅' : '❌'} ${e.label ?? e.id} ${e.ok ? 'answered' : 'failed'}`
  + ` in ${clock(e.ms)}${e.ok ? '' : ` — ${String(e.reason ?? '').slice(0, 90)}`}`;

function report(events) {
  for (const e of events) {
    switch (e.ev) {
      case 'stage_start':
        say(`▸ stage ${e.stage} started — ${(e.members ?? []).length} member(s)`);
        break;
      case 'member_done':
        say(memberLine(e));
        break;
      case 'tally':
        if (e.rubric && e.overall) say(`📊 score ${e.overall.median}/10 (range ${e.overall.min}–${e.overall.max})`);
        break;
      case 'run_done': {
        const s = e.score !== null && e.score !== undefined ? ` · score ${e.score}/10` : '';
        say(`🏁 finished — ${e.answered}/${e.requested} answered${s} · ${e.file ?? ''}`);
        break;
      }
      case 'run_error':
        say(`🚨 the run died: ${e.message}`);
        break;
      default: break;
    }
  }
}

// ── attach ──
const backlog = drain();
if (backlog.length) {
  // ONE line for everything that happened before we arrived, however much there was.
  const members = [...(state?.members?.values() ?? [])];
  const ok = members.filter((m) => m.state === 'ok').length;
  const failed = members.filter((m) => m.state === 'failed').length;
  const busy = members.filter((m) => m.state === 'running').map((m) => m.label);
  say(`▸ attached to a run already in progress (${backlog.length} events): stage ${state?.stage ?? '?'}`
    + ` · ${ok} answered, ${failed} failed`
    + `${busy.length ? ` · waiting on ${busy.join(', ')}` : ''}`);
  // If it had already ended before we attached, say so and stop rather than pretending to follow.
  if (ended) { report(backlog.filter((e) => e.ev === 'run_done' || e.ev === 'run_error')); }
}
firstPass = false;

if (ended) process.exit(ended === 'finished' ? 0 : 1);

const alive = () => {
  if (!pid) return true;                        // no pid recorded — cannot judge, so do not accuse
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

let lastBeat = Date.now();
const timer = setInterval(() => {
  report(drain());

  if (ended) {
    clearInterval(timer);
    process.exit(ended === 'finished' ? 0 : 1);
  }

  // **The death check.** A council can be legitimately silent for many minutes, so silence alone proves
  // nothing — the pid is what distinguishes thinking from gone. Without this the feed would simply stop
  // producing lines, which a reader cannot tell from a run still in progress.
  if (!alive() && Date.now() - lastGrowth > 5_000) {
    say(`💀 the council process (pid ${pid}) is gone and the stream never closed — the run is LOST`);
    clearInterval(timer);
    process.exit(4);
  }
  if (!pid && Date.now() - lastGrowth > quietDeadMs) {
    say(`⚠ no events for ${clock(Date.now() - lastGrowth)} and no pid recorded — treating the run as dead`);
    clearInterval(timer);
    process.exit(4);
  }

  // Heartbeat, on a fixed cadence: "still alive, here is where it is".
  if (Date.now() - lastBeat >= everyMs) {
    lastBeat = Date.now();
    const members = [...(state?.members?.values() ?? [])];
    const busy = members.filter((m) => m.state === 'running');
    const ok = members.filter((m) => m.state === 'ok').length;
    say(`⏳ ${clock(Date.now() - startedAt)} elapsed · stage ${state?.stage ?? '?'} · ${ok} answered`
      + `${busy.length ? ` · still thinking: ${busy.map((m) => `${m.label} (${clock(m.elapsedMs)})`).join(', ')}` : ''}`);
  }
}, 1000);

process.on('SIGINT', () => { clearInterval(timer); say('▸ stopped following (the council is still running)'); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
void firstPass;
