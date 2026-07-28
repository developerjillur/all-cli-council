#!/usr/bin/env node
// Does a detached council actually survive its session being killed? Proven, not asserted.
//
//   node tests/survives-session-death.mjs
//
// ── Why this is a separate file ────────────────────────────────────────────────────────────
//
// `tests/council.test.mjs` says it **spends nothing**, and that promise is worth keeping: it is why
// the suite can run on every push. This test makes one real member call, so it lives here, opt-in,
// and is named for exactly what it costs.
//
// ── Why it exists at all ───────────────────────────────────────────────────────────────────
//
// `--detach` exists for one reason: a 10–30 minute run must not die with the session that started it.
// The main suite checks that claim by grepping council.mjs for `detached: true` and `unref()` — which
// verifies the code was WRITTEN a certain way, not that the behaviour follows. Between those two
// there is an operating system, and the whole question is what it does.
//
// So this kills a session, for real, mid-run, and waits to see whether the answer still arrives.
//
// **The assertion that makes it conclusive is step 1.** A first version of this probe killed the
// launcher and then observed the council was gone — and reported that as a failure, when the council
// had simply finished first. "Killed" and "already finished" look identical unless you establish it
// was running BEFORE you pulled the rug. That is precisely the confusion `status.mjs` exists to
// prevent, made by the test that was supposed to validate it.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'scripts', 'council.mjs');
const STATUS = path.join(ROOT, 'scripts', 'status.mjs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
  return ok;
};

const member = process.argv.find((a) => a.startsWith('--members='))?.split('=')[1] ?? 'claude-sonnet';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'council-sessiondeath-'));

// Long enough that it is certainly still running when the rug comes out.
const QUESTION = 'Write six full paragraphs on why a long-running job should outlive the session that '
  + 'started it. Be thorough and specific.';

console.log('═'.repeat(72));
console.log('  DETACH — a killed session must not take the council with it');
console.log('═'.repeat(72));
console.log(`\n  one live call to ${member} · scratch: ${cwd}\n`);

// A stand-in for "the session": its own process group, so it can be killed the way a harness kills one.
const launcher = spawn(process.execPath, ['-e', `
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ${JSON.stringify(QUESTION)},
    ${JSON.stringify(`--members=${member}`)}, '--stage1-only', '--detach'],
    { encoding: 'utf8', cwd: ${JSON.stringify(cwd)} });
  fs.writeFileSync(${JSON.stringify(path.join(cwd, 'launch.json'))},
    (r.stdout || '').trim().split('\\n').pop() || '{}');
  setInterval(() => {}, 1000);            // then sit there, like a session waiting
`], { cwd, detached: true, stdio: 'ignore' });

let payload = {};
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  try { payload = JSON.parse(fs.readFileSync(path.join(cwd, 'launch.json'), 'utf8')); } catch { /* not yet */ }
  if (payload.pid) break;
}

if (!check('the launcher recorded a detached run', Boolean(payload.pid), JSON.stringify(payload).slice(0, 70))) {
  process.exit(1);
}

const pid = payload.pid;
const ppid = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

check('the council is re-parented away from its launcher', ppid === '1', `PPID ${ppid}`);
check('...and is NOT in the launcher\'s process group', pgid !== String(launcher.pid),
  `council PGID ${pgid}, launcher pid ${launcher.pid}`);

// ── step 1: the assertion without which nothing below means anything ──
if (!check('the council is RUNNING before the session is killed', alive(pid),
  'without this, "killed" and "already finished" are indistinguishable')) {
  console.log('\n  Inconclusive — it finished before the kill. Nothing was proven.\n');
  process.exit(1);
}

// ── step 2: kill the session outright ──
try { process.kill(-launcher.pid, 'SIGKILL'); } catch { /* group already gone */ }
try { process.kill(launcher.pid, 'SIGKILL'); } catch { /* already gone */ }
await sleep(2500);

check('the session is dead', !alive(launcher.pid));
const stillUp = alive(pid);
check('the council SURVIVED it', stillUp, stillUp ? '' : 'it was killed along with the session');

// ── step 3: and the answer still arrives ──
let final = {};
for (let i = 0; i < 80; i++) {
  const st = spawnSync(process.execPath, [STATUS, '--json'], { encoding: 'utf8', cwd });
  try { final = JSON.parse(st.stdout); } catch { /* nothing yet */ }
  if (final.state && final.state !== 'running') { final._exit = st.status; break; }
  await sleep(3000);
}

check('the orphaned run reached a terminal state', final.state === 'finished', `state: ${final.state}`);
check('...and status.mjs reports it with exit 0', final._exit === 0, `exit ${final._exit}`);

const md = final.runFile ? path.join(cwd, final.runFile) : null;
const body = md && fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
check('...and the run file is on disk', Boolean(body), md ?? '(no path)');
check('...containing a real answer, not a stub', body.length > 1500 && /Stage 1/.test(body),
  `${body.length} chars`);

fs.rmSync(cwd, { recursive: true, force: true });

console.log(`\n${'─'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(fail
  ? '\n  The core promise of --detach is NOT holding on this machine.\n'
  : '\n  A session was SIGKILLed mid-run and the council finished anyway. Proven, not asserted.\n');
process.exit(fail ? 1 : 0);
