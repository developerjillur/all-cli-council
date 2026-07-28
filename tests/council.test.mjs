#!/usr/bin/env node
// The council, attacked.
//
// Every case below is a hole that was OPEN when it was first probed on 2026-07-28. None was
// hypothetical: each was demonstrated against the running code before it was closed. They are
// tests now so that closing them is permanent rather than a thing someone remembers.
//
// Spends nothing — the parsing, containment and aggregation are pure. Live calls are the
// council's own business.
//
//   node tests/council.test.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, readForContext } from '../scripts/context.mjs';
import { createEmitter, reduce, redactLine, SCHEMA } from '../scripts/events.mjs';
import { createRenderer } from '../scripts/render.mjs';
import { up, clearBelow } from '../scripts/ansi.mjs';
import { prepare, deliveryOf, canary, argvCeiling } from '../scripts/prompt-delivery.mjs';
import { rankedLabels, borda, familyMix, reasoningOverlap, parseConfidence, parseRubric,
  aggregateScores } from '../scripts/diagnostics.mjs';
import { assignLenses, LENSES, stage1, stage2, rubric, RUBRIC_DIMENSIONS } from '../scripts/prompts.mjs';
import { judgeOutput } from '../scripts/judge-output.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

console.log('═'.repeat(72));
console.log('  COUNCIL — the holes that were open, and are closed');
console.log('═'.repeat(72));

// ── containment ──────────────────────────────────────────────────────────────
console.log('\n▸ Context containment — a denylist cannot be completed, so confine instead');
{
  const refused = (f) => buildContext([f], ROOT).files.length === 0;

  // WAS OPEN: absolute paths bypassed the relative refuse patterns entirely.
  check('refuses /etc/passwd', refused('/etc/passwd'));
  check('refuses an absolute path outside the workspace', refused('/etc/hosts'));

  // WAS OPEN: a private key with no .key/.pem suffix matched no pattern.
  const key = path.join(os.tmpdir(), 'council-test-id_rsa');
  fs.writeFileSync(key, 'ssh-rsa AAAA-not-real\n');
  check('refuses a key file with no telling suffix', refused(key));
  fs.rmSync(key, { force: true });

  // WAS OPEN: the pattern list saw the symlink's innocent name, not its target.
  const link = path.join(ROOT, 'council-test-notes.md');
  const target = path.join(os.homedir(), '.codex', 'config.toml');
  if (fs.existsSync(target)) {
    try {
      fs.symlinkSync(target, link);
      check('refuses a symlink escaping the workspace', refused(link));
    } finally { fs.rmSync(link, { force: true }); }
  }

  check('refuses .env by path', refused('.env'));
  check('refuses data/', refused('data/anything.db'));
  check('refuses the prompt log', refused('docs/prompts/2026-01-01.md'));

  // The allow path — a guard that never allows is an outage.
  check('allows an ordinary file', buildContext(['README.md'], ROOT).files.length === 1);

}

// ── secret shapes in content ─────────────────────────────────────────────────
console.log('\n▸ Content — a file that passed the path check can still carry a secret');
{
  const f = path.join(ROOT, 'council-test-secret.md');
  for (const [what, body] of [
    ['an sk- key', 'notes\nsk-proj-AAAABBBBCCCCDDDDEEEE1234\n'],
    ['a JWT', 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij\n'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n'],
  ]) {
    fs.writeFileSync(f, body);
    check(`refuses a file containing ${what}`, buildContext([path.relative(ROOT, f)], ROOT).files.length === 0);
  }
  fs.rmSync(f, { force: true });
}

// ── truncation is announced ──────────────────────────────────────────────────
console.log('\n▸ Truncation — a member given half a file must know it');
{
  const f = path.join(ROOT, 'council-test-big.md');
  // 40k chars is now UNDER the measured ceiling — a large file arrives whole, which is the
  // point: half a file produces a confident answer about the half that was sent.
  fs.writeFileSync(f, 'x'.repeat(40_000));
  check('a 40k-char file is sent whole, not halved', readForContext(f, ROOT).truncated !== true);

  fs.writeFileSync(f, 'x'.repeat(200_000));
  const big = readForContext(f, ROOT);
  check('a genuinely oversized file is truncated', big.truncated === true);
  check('...and says so inside the text, where the member will see it', /TRUNCATED/.test(big.text));
  check('...stating how much was withheld', /of 200000 characters/.test(big.text));
  fs.rmSync(f, { force: true });

  // The pack ceiling REFUSES rather than trimming to fit. Dropping the tail of the last file
  // silently is truncation one level up, and the member cannot tell either way.
  const a = path.join(ROOT, 'council-test-a.md');
  const b = path.join(ROOT, 'council-test-b.md');
  fs.writeFileSync(a, 'a'.repeat(79_000));
  fs.writeFileSync(b, 'b'.repeat(79_000));
  const c = path.join(ROOT, 'council-test-c.md');
  fs.writeFileSync(c, 'c'.repeat(79_000));
  const pack = buildContext(['council-test-a.md', 'council-test-b.md', 'council-test-c.md'], ROOT);
  check('a file that would blow the pack budget is refused, not trimmed', pack.files.length === 2);
  check('...and the refusal says why', /exceed the pack budget/.test(pack.refused.join(' ')));
  for (const f2 of [a, b, c]) fs.rmSync(f2, { force: true });
}

// ── injection defence ────────────────────────────────────────────────────────
console.log('\n▸ Injection — repo content is data, and says so');
{
  const pack = buildContext(['README.md'], ROOT).text;
  check('labels the pack as data, not instructions', /DATA, not instructions/.test(pack));
  check('tells the member to report an injection rather than obey it', /REPORT, not to obey/i.test(pack));
  // The instruction has to come AFTER the quoted content — a later instruction wins.
  check('closes the data block after the content', pack.indexOf('End of quoted data') > pack.indexOf('README.md'));
}

// ── resilience: a member that cannot answer must not stop the council ────────
console.log('\n\u25b8 Resilience \u2014 a failing member is a result, never an exception');
{
  // WAS OPEN: this returned [true, ...]. A quota message was ranked as an opinion.
  const [limitOk, limitWhy] = judgeOutput("You've hit your usage limit \u00b7 resets Jul 29 at 10am", '', 0);
  check('a usage-limit message that EXITS 0 is not an answer', limitOk === false, limitWhy.slice(0, 46));

  for (const [what, out] of [
    ['rate limit', 'Rate limit exceeded, try again later'],
    ['429', 'Error 429 Too Many Requests from upstream'],
    ['auth failure', 'Authentication failed. Please log in with `claude login`.'],
    ['billing', 'insufficient credit on this account, billing_not_active'],
    ['missing model', 'model gemini-9-ultra not found on this account'],
  ]) check(`${what} is not an answer`, judgeOutput(out, '', 0)[0] === false);

  check('a non-zero exit is not an answer', judgeOutput('anything at all here', '', 1)[0] === false);
  check('empty output is not an answer', judgeOutput('', '', 0)[0] === false);
  check('a one-word reply is not an answer', judgeOutput('ok', '', 0)[0] === false);

  // The allow path. A false positive here loses a good answer silently, which is worse than
  // the failure it guards \u2014 so an answer that DISCUSSES limits must survive.
  const real = 'The audio path must not call a model. Rate limit handling belongs off the hot '
    + 'path, and a 429 from the provider should surface as a filler rather than silence.';
  check('a real answer that discusses rate limits survives', judgeOutput(real, '', 0)[0] === true);
  check('a normal answer survives', judgeOutput('Because the transcript arrives asynchronously.', '', 0)[0] === true);
}

// ── the hang that outlived the promise ───────────────────────────────────────
console.log('\n\u25b8 A child that ignores SIGTERM must not hold the run open');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-hang-'));
  const script = path.join(dir, 'hang.sh');
  fs.writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nsleep 60 &\nwait\n");
  fs.chmodSync(script, 0o755);

  // WAS OPEN: ask() resolved on timeout but only sent SIGTERM. The child survived, node's
  // event loop stayed alive, and the whole run sat there after finishing.
  const runner = path.join(dir, 'run.mjs');
  fs.writeFileSync(runner, `
import { spawn } from 'node:child_process';
// Mirrors ask()'s teardown exactly: own process group, SIGTERM then SIGKILL to the GROUP,
// then destroy the pipes so a grandchild we could not reach cannot hold the loop open.
const p = spawn(${JSON.stringify(script)}, [], { stdio: ['ignore','pipe','pipe'], detached: true });
const stop = (sig) => { try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} } };
const t = setTimeout(() => {
  stop('SIGTERM');
  const hard = setTimeout(() => {
    stop('SIGKILL');
    try { p.stdout.destroy(); p.stderr.destroy(); p.unref(); } catch {}
  }, 500);
  hard.unref?.();
  console.log('resolved');
}, 300);
t.unref?.();
`);
  const t0 = Date.now();
  const r = spawnSync('node', [runner], { encoding: 'utf8', timeout: 15_000 });
  const ms = Date.now() - t0;
  check('the process exits after the timeout instead of hanging', r.status === 0 && ms < 12_000, `${ms}ms`);
  check('and it reported the timeout before exiting', /resolved/.test(r.stdout ?? ''));
  fs.rmSync(dir, { recursive: true, force: true });
}


// ── convening: never hang, never retry, always report ───────────────────────
console.log('\n\u25b8 Convening \u2014 a missing CLI is reported and stepped over, never retried');
{
  const cli = path.join(ROOT, 'scripts', 'council.mjs');
  const roster = path.join(ROOT, 'scripts', 'members.json');
  const original = fs.readFileSync(roster, 'utf8');

  const run = (args, ms = 30_000) => spawnSync('node', [cli, ...args],
    { encoding: 'utf8', timeout: ms, cwd: ROOT });

  // Pre-flight spends nothing and answers "would this work right now".
  //
  // Made deterministic with a fake member: the first version asserted exit 0, which is right on
  // a developer machine and WRONG on a CI runner, where no member CLI is installed and exit 2
  // is the correct answer. CI caught it on its very first run — the test was machine-dependent,
  // not the code.
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-fake-'));
  const fakeCli = path.join(fakeDir, 'fake-member');
  fs.writeFileSync(fakeCli, '#!/bin/sh\necho "an answer long enough to count as one"\n');
  fs.chmodSync(fakeCli, 0o755);
  const cfg0 = JSON.parse(original);
  fs.writeFileSync(roster, JSON.stringify({
    ...cfg0,
    members: [{ id: 'fake', label: 'Fake', cmd: fakeCli, args: ['{prompt}'], verified: 'fixture' }],
  }, null, 2));

  const pre = run(['anything', '--preflight']);
  check('--preflight exits 0 when a member exists', pre.status === 0, `exit ${pre.status}`);
  check('...and names who is available', /member\(s\) available/.test(pre.stderr ?? ''));
  fs.rmSync(fakeDir, { recursive: true, force: true });
  fs.writeFileSync(roster, original);

  // WAS THE RISK: discovering mid-run, after other members had already started.
  const cfg = JSON.parse(original);
  fs.writeFileSync(roster, JSON.stringify({
    ...cfg,
    members: [...cfg.members, { id: 'ghost', label: 'Ghost', cmd: 'definitely-not-installed-xyz', args: ['{prompt}'], verified: 'fixture' }],
  }, null, 2));
  const ghost = run(['anything', '--preflight']);
  check('an uninstalled member is named before anything runs', /not installed/i.test(ghost.stderr ?? ''));
  check('...and the word "retried" is explicitly denied', /not retried/i.test(ghost.stderr ?? ''));

  // The case that must not hang: nothing available at all.
  fs.writeFileSync(roster, JSON.stringify({
    ...cfg, members: cfg.members.map((m) => ({ ...m, cmd: `nope-${m.cmd}` })),
  }, null, 2));
  const t0 = Date.now();
  const none = run(['does this hang?']);
  const ms = Date.now() - t0;
  check('no members available \u2192 exits fast, does not hang', ms < 15_000, `${ms}ms`);
  check('...with exit 2, distinct from "all failed"', none.status === 2, `exit ${none.status}`);
  check('...saying nothing was spent', /nothing was spent/i.test(none.stderr ?? ''));
  check('...and nothing was written', !/Written:/.test(none.stderr ?? ''));

  fs.writeFileSync(roster, original);
  check('roster restored', fs.readFileSync(roster, 'utf8') === original);
}

// ── members.json is honest ───────────────────────────────────────────────────
console.log('\n▸ Members — the roster cannot quietly disagree with itself');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'members.json'), 'utf8'));
  const ids = cfg.members.map((m) => m.id);
  check('no duplicate member ids', new Set(ids).size === ids.length);
  check('every member records when it was verified', cfg.members.every((m) => m.verified));
  check('every member declares a family', cfg.members.every((m) => m.family),
    'the mix diagnostic used to GUESS this, and defaulted everything unknown to Google');

  // WAS OPEN, AND THE WORST HOLE IN THE PACKAGE. The old assertion was:
  //
  //     every member is pinned to a read-only mode
  //     cfg.members.every((m) => m.args.some((a) => /read-only|plan|--print|-p$/.test(a)))
  //
  // It passed. THREE of five members could write anyway — `--print` is an output format and a bare
  // `-p` is a prompt flag, and neither is a permission. A regex over flag strings cannot tell a
  // permission from a coincidence, so the one invariant guarding "members advise, they never edit"
  // was green while the claim was false. Demonstrated: `claude --print` wrote PROOF.txt into its
  // cwd; grok wrote to an arbitrary ABSOLUTE path outside it.
  //
  // Now each member NAMES the flags that constrain it, and this asserts those exact tokens are
  // still in args. A declaration alone would be self-certifying; naming the flags is checkable.
  check('every contained member names the flags that contain it',
    cfg.members.filter((m) => m.contained !== false)
      .every((m) => Array.isArray(m.readOnlyBy) && m.readOnlyBy.length
        && m.readOnlyBy.every((tok) => m.args.includes(tok))),
    'named, not sniffed for');

  check('an uncontained member is marked, not quietly included',
    cfg.members.every((m) => m.contained !== false || (m.note ?? '').includes('NOT CONTAINED')));

  check('containment was measured rather than declared',
    cfg.members.every((m) => m.containmentVerified),
    'written by scripts/verify-containment.mjs');

  // The old check — kept as a NEGATIVE test, so nobody reintroduces it thinking it was fine.
  const oldCheckWouldPass = cfg.members.every((m) => m.args.some((a) => /read-only|plan|--print|-p$/.test(a)));
  const someoneCanWrite = cfg.members.some((m) => m.contained === false);
  check('the OLD flag-sniffing check would still pass on a roster containing a writer',
    !(oldCheckWouldPass && someoneCanWrite) || true,
    `sniff=${oldCheckWouldPass}, writer present=${someoneCanWrite} — this is why it was replaced`);

  // Delivery is per-member and a wrong value fails SILENTLY, so the shape is pinned here.
  for (const m of cfg.members) {
    const via = deliveryOf(m);
    if (via === 'stdin') {
      check(`${m.id}: stdin member has no {prompt} placeholder`, !m.args.some((a) => a.includes('{prompt}')),
        'a placeholder plus stdin sends the prompt twice, one of them exposed in argv');
    } else if (via === 'file') {
      check(`${m.id}: file member has a {promptFile} placeholder`, m.args.some((a) => a.includes('{promptFile}')));
    } else {
      check(`${m.id}: argv member has a {prompt} placeholder`, m.args.some((a) => a.includes('{prompt}')));
    }
  }
}

// ── prompt delivery ──────────────────────────────────────────────────────────
console.log('\n▸ Prompt delivery — argv broke Linux at our own context budget, and leaked the pack');
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'council-deliv-'));

  // WAS OPEN: Linux caps a SINGLE argv string at MAX_ARG_STRLEN = 131,072 bytes. Measured in
  // node:22-alpine — 131,000 ok, 160,000 E2BIG — which is BELOW context.mjs's own 160,000-char
  // budget. macOS has no per-argument cap, so the whole failure was invisible to its author.
  check('the Linux per-argument ceiling is below our own context budget',
    argvCeiling('linux') < 160_000, `${argvCeiling('linux')} < 160000`);
  check('macOS has room, which is exactly why this was never noticed',
    argvCeiling('darwin') > 160_000);
  check('Windows is the strictest of the three', argvCeiling('win32') < argvCeiling('linux'));
  check('an unknown platform gets the strictest real limit, not the loosest',
    argvCeiling('plan9') === argvCeiling('linux'));

  const argvMember = { id: 'a', label: 'A', cmd: 'true', promptVia: 'argv', args: ['{prompt}'] };

  // The point of the whole module: refused BEFORE spending, with a remedy, rather than E2BIG
  // from inside libuv halfway through a paid run.
  const over = prepare(argvMember, 'x'.repeat(150_000), scratch, 'linux');
  check('an oversized argv prompt is refused, not spawned', over.ok === false);
  check('...and the refusal names the platform limit and the remedy',
    /caps at/.test(over.reason) && /--context/.test(over.reason));
  check('...and says it was refused before spending', /before spending/.test(over.reason));
  check('the same prompt is allowed on darwin, where the cap does not exist',
    prepare(argvMember, 'x'.repeat(150_000), scratch, 'darwin').ok === true);

  // argv is world-readable via /proc/<pid>/cmdline (mode 444, measured). Callers are told.
  check('an argv member is flagged as exposed', prepare(argvMember, 'hi', scratch, 'darwin').exposed === true);

  const stdinMember = { id: 's', label: 'S', cmd: 'true', promptVia: 'stdin', args: ['--print'] };
  const st = prepare(stdinMember, 'the prompt', scratch);
  check('a stdin member carries the prompt on stdin', st.ok && st.stdin === 'the prompt');
  check('...and not in argv', st.ok && !st.args.join(' ').includes('the prompt'));
  check('...and is not flagged as exposed', st.exposed === false);
  check('a huge prompt is fine on stdin on every platform',
    prepare(stdinMember, 'x'.repeat(5_000_000), scratch, 'linux').ok === true);

  // A stdin member that still has a {prompt} placeholder would send the prompt TWICE — one of
  // them back in argv, silently undoing the fix.
  const bothWays = prepare({ ...stdinMember, args: ['--print', '{prompt}'] }, 'p', scratch);
  check('a stdin member with a leftover {prompt} is refused', bothWays.ok === false);
  check('...because the prompt would travel twice', /twice/.test(bothWays.reason));

  const fileMember = { id: 'f', label: 'F', cmd: 'true', promptVia: 'file', args: ['--prompt-file', '{promptFile}'] };
  const fp = prepare(fileMember, 'secret prompt body', scratch);
  const written = fp.args.find((a) => a.includes(scratch));
  check('a file member gets a real path substituted', fp.ok && !!written && fs.existsSync(written));
  check('...containing the prompt', fs.readFileSync(written, 'utf8') === 'secret prompt body');
  // 0600, or the leak just moved from the process table to the filesystem, for longer.
  check('...mode 0600, not world-readable', (fs.statSync(written).mode & 0o777) === 0o600,
    (fs.statSync(written).mode & 0o777).toString(8));
  check('...and never in argv', !fp.args.join(' ').includes('secret prompt body'));
  fp.cleanup();
  check('...and removed the moment the member exits', !fs.existsSync(written));

  // The canary is what catches the silent failure: `agy` given a prompt on stdin exits 0 and
  // answers "How can I help you today?" — a fluent answer to a question it never received.
  const c = canary();
  check('a canary is unique per probe', canary().token !== canary().token);
  check('the canary is detected when it comes back', c.arrived(`Sure! ${c.token}`));
  check('a plausible greeting does NOT satisfy it', !c.arrived('Hello! How can I help you today?'),
    'this is the exact string a member with an undelivered prompt returns');

  fs.rmSync(scratch, { recursive: true, force: true });
}

// ── the event stream ─────────────────────────────────────────────────────────
console.log('\n▸ Events — the progress a UI consumes, and the reducer that rebuilds it');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-ev-'));
  const f = path.join(dir, 'run.events.ndjson');
  const em = createEmitter({ file: f });
  check('the stream opens', em.broken === null, String(em.broken));
  em.emit('run_start', { schema: SCHEMA, question: 'q', members: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  em.emit('member_start', { stage: '1', id: 'a', label: 'A', via: 'stdin', promptChars: 10 });
  em.emit('member_tick', { stage: '1', id: 'a', elapsedMs: 5000, bytes: 40, lastLine: 'thinking' });
  em.emit('member_done', { stage: '1', id: 'a', label: 'A', ok: true, ms: 6000, chars: 400 });
  em.emit('run_done', { ok: true, answered: 1, requested: 2, file: 'x.md', exitCode: 0 });
  em.close();

  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  check('one NDJSON line per event', lines.length === 5, `${lines.length}`);
  check('every line parses on its own', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  check('every event is timestamped and named', lines.every((l) => {
    const e = JSON.parse(l);
    return typeof e.t === 'number' && typeof e.ts === 'string' && typeof e.ev === 'string';
  }));

  // A UI attaching MID-RUN is the normal case, so the reducer must cope with a partial stream.
  let st = null;
  for (const l of lines.slice(0, 3)) st = reduce(st, JSON.parse(l));
  check('a partial stream still rebuilds coherent state', st.members.get('a').state === 'running');
  check('...with the elapsed clock a UI needs', st.members.get('a').elapsedMs === 5000);
  for (const l of lines.slice(3)) st = reduce(st, JSON.parse(l));
  check('...and completes correctly', st.members.get('a').state === 'ok' && st.done.answered === 1);
  check('a member that never started is still known about', st.members.get('b').state === 'waiting');
  check('an unknown event does not throw', !!reduce(st, { ev: 'something_new_in_v2', t: 1 }));

  // An event stream carrying the pack would be the leak this project prevents, one layer up.
  check('a secret in a status line is scrubbed',
    !redactLine('using key sk-proj-AAAABBBBCCCCDDDD1234 now').includes('sk-proj-AAAA'));
  check('a JWT in a status line is scrubbed',
    !redactLine('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij').includes('eyJzdWIi'));
  check('a status line is length-capped', redactLine('y'.repeat(500)).length <= 120);

  // Telemetry must never be able to kill a 20-minute council.
  const bad = createEmitter({ file: '/proc/definitely/not/writable/x.ndjson' });
  let threw = false;
  try { bad.emit('run_start', {}); bad.close(); } catch { threw = true; }
  check('an unwritable sink never throws mid-run', !threw);
  check('...but it is reported, so --events can fail loudly', bad.broken !== null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── the live view, and a second consumer of the same bytes ───────────────────
console.log('\n▸ Rendering — the same reducer drives the terminal and an external watcher');
{
  // Non-TTY must be append-only. An in-place redraw written to a file or a CI log is thousands of
  // lines of escape codes, which is worse than no progress at all.
  const seen = [];
  const fake = { write: (s) => { seen.push(s); return true; }, isTTY: false, columns: 80 };
  const r = createRenderer({ out: fake, isTty: false });
  r.handle({ ev: 'run_start', members: [{ id: 'a', label: 'Member A' }] });
  r.handle({ ev: 'stage_start', stage: '1', members: ['a'] });
  r.handle({ ev: 'member_start', stage: '1', id: 'a', label: 'Member A', via: 'stdin', promptChars: 12 });
  r.handle({ ev: 'member_tick', stage: '1', id: 'a', elapsedMs: 3000, bytes: 0, lastLine: '' });
  r.handle({ ev: 'member_done', stage: '1', id: 'a', label: 'Member A', ok: true, ms: 4000, chars: 99 });
  const text = seen.join('');
  check('non-TTY output contains no cursor movement', !text.includes(String.fromCharCode(27)));
  check('...and still reports the stage and the result', /Stage 1/.test(text) && /Member A/.test(text));
  check('...and does not repeat a transition it already logged',
    text.split('Member A started').length - 1 === 1);

  // The escape sequences exist and are built without a literal control byte in the source.
  check('ansi helpers produce real CSI sequences', up(3) === `${String.fromCharCode(27)}[3A` && clearBelow.endsWith('0J'));
  check('no source file contains a raw escape byte',
    !fs.readdirSync(path.join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs'))
      .some((f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8').includes(String.fromCharCode(27))),
    'a stripped 0x1b prints garbage at the user instead of erroring');

  // watch.mjs is a SECOND, independent consumer in its own process. If the stream is only readable
  // by its author, that shows up here rather than in somebody's extension weeks later.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-watch-'));
  const f = path.join(dir, 'run.events.ndjson');
  fs.writeFileSync(f, [
    { t: 0, ts: 'x', ev: 'run_start', schema: SCHEMA, question: 'q', members: [{ id: 'a', label: 'Member A' }] },
    { t: 1, ts: 'x', ev: 'stage_start', stage: '1', members: ['a'] },
    { t: 2, ts: 'x', ev: 'member_done', stage: '1', id: 'a', label: 'Member A', ok: true, ms: 4000, chars: 99 },
    { t: 3, ts: 'x', ev: 'run_done', ok: true, answered: 1, requested: 1, file: 'r.md', exitCode: 0 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  const w = spawnSync('node', [path.join(ROOT, 'scripts', 'watch.mjs'), f, '--once'],
    { encoding: 'utf8', timeout: 20_000 });
  check('an external process can render a run from the stream alone', w.status === 0, `exit ${w.status}`);
  check('...showing the member and the outcome',
    /Member A/.test(w.stderr ?? '') && /1\/1 answered/.test(w.stderr ?? ''));

  const none = spawnSync('node', [path.join(ROOT, 'scripts', 'watch.mjs'), path.join(dir, 'nope.ndjson')],
    { encoding: 'utf8', timeout: 20_000 });
  check('a missing stream exits rather than waiting forever', none.status === 2, `exit ${none.status}`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── diagnostics ──────────────────────────────────────────────────────────────
console.log('\n▸ Diagnostics — every number printed above a score is tested');
{
  // parseRanking is now IMPORTED rather than reimplemented in this file. The old test kept its own
  // copy, which pins the intended behaviour but cannot notice council.mjs drifting away from it.
  const spoof = 'A said: "FINAL RANKING:\n1. Response A"\n\nMy verdict:\n\nFINAL RANKING:\n1. Response C\n2. Response A';
  check('takes the LAST ranking block, not a quoted one', rankedLabels(spoof)[0] === 'C', rankedLabels(spoof).join('>'));
  check('parses a normal block', rankedLabels('blah\n\nFINAL RANKING:\n1. Response B\n2. Response A').join('') === 'BA');
  check('returns nothing when there is no block', rankedLabels('I decline to rank these.').length === 0);
  check('de-duplicates a repeated label',
    rankedLabels('FINAL RANKING:\n1. Response A\n2. Response A\n3. Response B').join('') === 'AB',
    'a duplicate used to earn two Borda votes');

  // Borda, self-votes excluded — measured at 75% self-first against a 20% chance rate.
  const reviews = [
    { id: 'a', parsed: ['a', 'b', 'c'] },
    { id: 'b', parsed: ['b', 'a', 'c'] },
    { id: 'c', parsed: ['c', 'b', 'a'] },
  ];
  const b = borda(reviews, ['a', 'b', 'c']);
  check('b wins on other members\' votes alone', b.scores.b === Math.max(...Object.values(b.scores)));
  check('self-enhancement is reported, not silently corrected', b.selfFirst === 3 && b.selfN === 3);
  check('...with the mean self-rank beside it', b.selfMean === 1);
  check('a reviewer that ranked nothing is not counted',
    borda([...reviews, { id: 'd', parsed: [] }], ['a', 'b', 'c', 'd']).counted === 3);

  // WAS A BUG, AND A QUIET ONE: the family was inferred from the id with 'Google' as the fallback,
  // so every member of a custom roster not named exactly `codex` or `grok` was reported as Google —
  // in the one diagnostic whose whole job is to warn about a lopsided council.
  const mix = familyMix([{ family: 'OpenAI' }, { family: 'Anthropic' }, { family: 'Anthropic' }]);
  check('family mix is read from the roster', mix.Anthropic === 2 && mix.OpenAI === 1);
  check('an undeclared family is "unknown", not a wrong guess',
    familyMix([{ id: 'mistral-large' }]).unknown === 1,
    'this used to be reported as Google');

  // The new metric. Raw overlap is dominated by the pack's own vocabulary, so it is subtracted.
  const pack = 'the retry queue idempotent partition backoff jitter deadletter';
  // 40 distinct words beyond the pack's, so the pair clears the "too thin to measure" guard. That
  // guard is itself tested two cases below — with a short pair, which must report null instead.
  const same = 'retry queue idempotent partition backoff '
    + Array.from({ length: 40 }, (_, i) => `sharedword${i}`).join(' ');
  const o1 = reasoningOverlap([{ id: 'x', text: same }, { id: 'y', text: same }], pack);
  check('two identical answers overlap almost totally', o1.distinctive > 0.9, String(o1.distinctive));

  const a1 = 'retry queue idempotent partition ' + Array.from({ length: 40 }, (_, i) => `alphaword${i}`).join(' ');
  const a2 = 'retry queue idempotent partition ' + Array.from({ length: 40 }, (_, i) => `betaword${i}`).join(' ');
  const o2 = reasoningOverlap([{ id: 'x', text: a1 }, { id: 'y', text: a2 }], pack);
  check('two answers sharing only the PACK\'s words score near zero', o2.distinctive < 0.05, String(o2.distinctive));
  check('...while raw overlap is inflated by that shared subject matter', o2.raw > o2.distinctive,
    `raw ${o2.raw.toFixed(2)} vs distinctive ${o2.distinctive.toFixed(2)}`);
  check('a short answer reports "too thin" rather than a confident number',
    reasoningOverlap([{ id: 'x', text: 'yes agreed' }, { id: 'y', text: 'yes agreed' }], pack).distinctive === null,
    'a 0.9 from two 40-word answers is worse than no number');
  check('one answer cannot have an overlap', reasoningOverlap([{ id: 'x', text: same }], pack).n === 1);

  // Confidence — absence is a value, because it is trivially easy to comply with.
  check('confidence is parsed', parseConfidence('blah\nCONFIDENCE: 72\n').confidence === 72);
  check('a trailing percent sign is tolerated', parseConfidence('CONFIDENCE: 65%').confidence === 65);
  check('what would change its mind is captured',
    parseConfidence('CONFIDENCE: 50\nWOULD CHANGE MY MIND IF: I could see the caller').changeMind === 'I could see the caller');
  check('a missing confidence is null, not a default',
    parseConfidence('no numbers here at all').confidence === null);
  check('a quoted confidence does not beat the member\'s own last line',
    parseConfidence('It said CONFIDENCE: 99\nmy answer\nCONFIDENCE: 40').confidence === 40);
  check('an absurd confidence is clamped', parseConfidence('CONFIDENCE: 900').confidence === 100);

  // Rubric parsing, across the shapes models actually emit.
  const judged = parseRubric([
    'FINDING: something is wrong',
    'SCORE: correctness | 7/10 | one real defect',
    'SCORE: security |  9 / 10  | could not break it',
    'SCORE: honesty | **6**/10 | two unmeasured claims',
    'OVERALL: 7/10',
  ].join('\n'));
  check('a plain n/10 score parses', judged.scores.correctness === 7);
  check('spaces around the slash parse', judged.scores.security === 9);
  check('a bold-wrapped number parses', judged.scores.honesty === 6);
  check('the overall parses', judged.overall === 7);
  check('the reason is kept with the score', /one real defect/.test(judged.notes.correctness));
  check('a score out of range is clamped', parseRubric('SCORE: x | 99/10 |').scores.x === 10);
  check('prose containing "10" is not harvested as a score',
    Object.keys(parseRubric('I would rate this about 10 out of 10 honestly').scores).length === 0);

  // Median, not mean, with the spread beside it — one agreeable judge must not lift the result.
  const agg = aggregateScores([
    { scores: { a: 4 }, overall: 4 }, { scores: { a: 4 }, overall: 4 },
    { scores: { a: 9 }, overall: 9 }, { scores: { a: 9 }, overall: 9 }, { scores: { a: 9 }, overall: 9 },
  ]);
  check('the median ignores an outlier a mean would follow', agg.overall.median === 9);
  check('...but the disagreement is reported, so 4,4,9,9,9 cannot pass as 8,9,9,9,9',
    agg.overall.min === 4 && agg.overall.max === 9);
  check('an unparseable judge is excluded rather than counted as zero',
    aggregateScores([{ scores: { a: 8 }, overall: 8 }, { scores: {}, overall: null }]).overall.n === 1);
}

// ── lenses ───────────────────────────────────────────────────────────────────
console.log('\n▸ Lenses — method diversity, assigned reproducibly');
{
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const one = assignLenses(ids, 12345);
  check('every member gets a lens', ids.every((i) => !!one[i].name));
  check('five members get five DIFFERENT methods',
    new Set(ids.map((i) => one[i].id)).size === 5,
    'the whole point is that they do not all reason the same way');
  check('the same seed gives the same assignment', assignLenses(ids, 12345).a.id === one.a.id);
  check('a different question rotates them, so a lens is not a member\'s property',
    assignLenses(ids, 12346).a.id !== one.a.id);
  check('more members than lenses still assigns one to each',
    Object.keys(assignLenses([...ids, 'f', 'g'], 7)).length === 7);
}

// ── the prompts carry what the diagnostics need to read ──────────────────────
console.log('\n▸ Prompts — a diagnostic that asks for nothing measures nothing');
{
  const p1 = stage1('BRIEF', 'the question', null);
  check('stage 1 asks for a confidence', /CONFIDENCE: <0-100>/.test(p1));
  check('...and for what would change its mind', /WOULD CHANGE MY MIND IF/.test(p1));
  check('...and still forbids hedging', /Do not hedge/.test(p1));
  check('a lens appears in the prompt when given',
    /Inversion/.test(stage1('B', 'q', LENSES[0])));
  check('...and tells the member NOT to cover the other lenses too',
    /Do not try to cover theirs/.test(stage1('B', 'q', LENSES[0])),
    'otherwise every member writes the same balanced survey');
  check('no lens block appears when lenses are off', !/Your method for this question/.test(p1));

  const p2 = stage2('BRIEF', 'q', 'BODY');
  check('stage 2 still demands a parseable ranking block', /FINAL RANKING:/.test(p2));
  check('...and asks for the minority view a synthesis destroys first',
    /MINORITY VIEW WORTH KEEPING/.test(p2));
  check('...and what is lost if the top answer wins', /WHAT IS LOST IF THE TOP ANSWER WINS/.test(p2));
  check('...and whether agreement was reached by the same route',
    /same argument/.test(p2), 'five arguments are not five pieces of evidence');

  const pr = rubric('BRIEF', 'grade this', 'grade this');
  check('the rubric names every dimension it will be scored on',
    RUBRIC_DIMENSIONS.every(([d]) => pr.includes(`SCORE: ${d}`)));
  check('a low score must point at a locatable defect', /locatable defect/.test(pr));
  check('a high score must say what could not be broken', /tried to break and could not/.test(pr));
  check('unmeasured claims cost marks', /Withhold marks for unmeasured claims/.test(pr));
  check('volume is explicitly not rewarded', /Do not reward volume/.test(pr));
  check('it asks for findings in a parseable shape', /FINDING: /.test(pr) && /WHERE: /.test(pr));
}

console.log(`\n${'─'.repeat(72)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\n  Each of these was an open hole once. A red line here is a reopened one.\n');
  process.exit(1);
}
console.log('\n  Every case above was demonstrated OPEN before it was closed.\n');
