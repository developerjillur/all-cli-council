#!/usr/bin/env node
// Where is the council, right now? One question, one cheap answer, from any session.
//
//   node scripts/status.mjs                 # the newest run in .council/runs/
//   node scripts/status.mjs <file.ndjson>   # a specific one
//   node scripts/status.mjs --json          # for a program
//
// ── Why this exists ───────────────────────────────────────────────────────────────────────
//
// `watch.mjs` FOLLOWS a run — the right tool when you intend to sit and look. This answers the other
// question, the one an agent actually asks: **"is it done, and if not, is it still alive?"** It reads,
// answers, and exits. Nothing to interrupt, nothing to time out, nothing to block on.
//
// The distinction that matters is the third state. A stream that has stopped growing is either a
// council thinking hard — the normal condition of this tool for minutes at a time — or a process that
// died and will never write again. Those look **identical** from the file alone, and confusing them is
// how you either kill a working run or wait forever on a dead one. `run_start` carries the pid, so this
// can stop guessing and ask the kernel.
//
// The exit code is the answer, so a script need not parse anything:
//
//     0  finished, usable        run_done, and somebody answered
//     1  finished, failed        run_error, or nobody answered
//     2  no run found            nothing to report on
//     3  STILL RUNNING           the pid is alive and there is no terminal event yet
//     4  died without finishing  the pid is gone and there is no terminal event — the run is lost

import fs from 'node:fs';
import path from 'node:path';
import { reduce } from './events.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
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

const finish = (obj, code) => {
  if (asJson) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  process.exit(code);
};

if (!file || !fs.existsSync(file)) {
  if (!asJson) process.stderr.write('\n  No council run found under .council/runs/.\n\n');
  finish({ state: 'none' }, 2);
}

// ── fold the stream ──
let state = null;
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
for (const l of lines) {
  // A partial final line is normal: the file is being appended to while this reads it.
  try { state = reduce(state, JSON.parse(l)); } catch { /* skip it */ }
}
const first = (() => { try { return JSON.parse(lines[0]); } catch { return {}; } })();

/**
 * Is the process still there?
 *
 * `kill(pid, 0)` sends no signal — it only asks whether the pid exists and is signallable. `EPERM`
 * means it exists and belongs to someone else, which still answers the question.
 */
const alive = (pid) => {
  if (!pid) return null;                    // an older stream with no pid recorded
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const pid = first.pid ?? null;
const running = alive(pid);
const done = state?.done ?? null;
const errored = state?.error ?? null;

const members = [...(state?.members?.values() ?? [])];
const inState = (s) => members.filter((m) => m.state === s);
const quietMs = Date.now() - fs.statSync(file).mtimeMs;
const clock = (ms) => {
  const sec = Math.round((ms ?? 0) / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
};

let stateName;
let code;
if (errored) { stateName = 'failed'; code = 1; }
else if (done) { stateName = done.answered > 0 ? 'finished' : 'failed'; code = done.answered > 0 ? 0 : 1; }
else if (running === false) { stateName = 'died'; code = 4; }
else { stateName = 'running'; code = 3; }

const report = {
  state: stateName,
  file: path.relative(process.cwd(), file),
  question: state?.question ?? null,
  pid,
  pidAlive: running,
  stage: state?.stage ?? null,
  quietFor: clock(quietMs),
  members: members.map((m) => ({ id: m.id, label: m.label, state: m.state, elapsedMs: m.elapsedMs ?? null })),
  answered: inState('ok').length,
  failed: inState('failed').length,
  stillThinking: inState('running').map((m) => m.label),
  score: done?.score ?? null,
  runFile: done?.file ?? null,
  error: errored,
};

if (!asJson) {
  const w = (s) => process.stderr.write(`${s}\n`);
  const headline = {
    finished: '✅ finished',
    failed: '❌ failed',
    running: '⏳ still running',
    died: '💀 died without finishing',
  }[stateName];

  w('');
  w(`  ${headline}`);
  w(`     ${report.question
    ? `"${String(report.question).slice(0, 68)}${report.question.length > 68 ? '…' : ''}"`
    : '(no question recorded)'}`);
  w('');
  for (const m of report.members) {
    const mark = { ok: '✅', failed: '❌', running: '⏳', absent: '·', waiting: '·' }[m.state] ?? '·';
    w(`     ${mark} ${String(m.label).padEnd(30)} ${m.state}${m.elapsedMs ? ` · ${clock(m.elapsedMs)}` : ''}`);
  }
  w('');

  if (stateName === 'running') {
    w(`     ${report.answered} answered · ${report.stillThinking.length} still thinking`
      + `${report.stillThinking.length ? `: ${report.stillThinking.join(', ')}` : ''}`);
    w(`     last event ${report.quietFor} ago · pid ${pid ?? '?'} is alive`);
    w('');
    w('     Nothing to do but wait. This command is cheap — ask again whenever.');
  } else if (stateName === 'died') {
    w(`     pid ${pid} is gone and the stream has no terminal event. **The run is lost** — the`);
    w('     members were spent and there is no synthesis. The child\'s output is in');
    w(`     ${path.relative(process.cwd(), file).replace('.events.ndjson', '.log')}`);
  } else if (stateName === 'finished') {
    w(`     ${report.answered} answered${report.score !== null ? ` · score ${report.score}/10` : ''}`);
    if (report.runFile) w(`     ▸ ${report.runFile}`);
  } else {
    w(`     ${report.error ?? 'no member answered'}`);
  }
  w('');
}

finish(report, code);
