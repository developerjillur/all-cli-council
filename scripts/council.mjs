#!/usr/bin/env node
// The council — four models, three vendors, three stages, no API.
//
// Five and four until 2026-07-28, when one member was measured able to write files and no flag it
// offers stopped it. It stays in the roster, excluded by default. See verify-containment.mjs.
//
// Adapted from karpathy/llm-council (23,287★, no licence — so this is written from its described
// algorithm, not copied). His shape: every model answers, every model ranks the others anonymised,
// a chairman synthesises.
//
// What differs, and why. The first four are because his council answers general questions while
// this one answers questions about a specific codebase; the rest came from measuring this one.
//
//   1. CONTEXT IS ASSEMBLED AND PASSED.  His members need none — the question is self-contained.
//      Ours were given the question and nothing else, which made them five confident guesses about
//      code none of them had read. See context.mjs for why the obvious fix (run them in the repo,
//      read-only) is one this project has already disproven: read-only means cannot WRITE.
//   2. THE ORDER IS SHUFFLED PER REVIEWER.  His labels responses A,B,C… in a fixed order for
//      everyone, so position bias points the same way for every reviewer and compounds. Each
//      reviewer here sees its own permutation, seeded from the question so a run is reproducible.
//   3. RANKINGS ARE PARSED AND AGGREGATED.  His forces a FINAL RANKING: block and parses it; the
//      first version here asked for prose and could not tell you who won. Borda count, with
//      self-votes excluded because they were measured and they dominate.
//   4. STAGE 3 IS NOT A SUBPROCESS.  His chairman is another API call. Ours is the session that ran
//      the council, so the synthesis happens with the conversation in context.
//   5. PROGRESS IS EMITTED, NOT INFERRED.  His backend has an SSE endpoint and a web front end;
//      this printed nothing for minutes at a time. Now every run can emit an NDJSON event stream
//      (`--events`) that a terminal, a watcher, or an editor extension consumes identically — and
//      the reason it is a parent-side clock rather than relayed model output is a measurement,
//      recorded in events.mjs.
//   6. THE PROMPT DOES NOT TRAVEL IN argv.  It used to, which broke Linux at this project's own
//      context budget and published the pack to the process table. See prompt-delivery.mjs.
//   7. AGREEMENT IS MEASURED, NOT JUST DISCLAIMED.  Every run said "consensus is not correctness"
//      in prose. `reasoningOverlap` now puts a number on it, with the shared subject matter
//      subtracted out. See diagnostics.mjs.
//
//   node scripts/council.mjs "<question>" [--context file ...]
//        [--stage1-only] [--revise] [--members=id,id] [--lenses] [--rubric]
//        [--events[=path]] [--json-events] [--no-live] [--timeout=<min>]
//        [--preflight] [--verify-delivery]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildContext, loadBrief } from './context.mjs';
import { judgeOutput } from './judge-output.mjs';
import { createEmitter, redactLine, SCHEMA } from './events.mjs';
import { createRenderer } from './render.mjs';
import { prepare, deliveryOf, canary, argvCeiling } from './prompt-delivery.mjs';
import { borda, verbosityR, familyMix, reasoningOverlap, parseConfidence, parseRubric,
  aggregateScores, rankedLabels, OVERLAP_SUSPECT } from './diagnostics.mjs';
import * as P from './prompts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
// Members: the project's own roster if it has one, otherwise the packaged default.
const localRoster = path.join(process.cwd(), '.council', 'members.json');
const rosterPath = fs.existsSync(localRoster) ? localRoster : path.join(HERE, 'members.json');
const CFG = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
const OUT_DIR = path.join(ROOT, '.council', 'runs');

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`) || argv.some((a) => a.startsWith(`--${n}=`));
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const ctxFiles = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--context' || argv[i] === '--card') {
    while (argv[i + 1] && !argv[i + 1].startsWith('--')) ctxFiles.push(argv[++i]);
  }
}
const question = argv.filter((a) => !a.startsWith('--') && !ctxFiles.includes(a)).join(' ').trim();
const stage1Only = has('stage1-only');
const useLenses = has('lenses');
const rubricMode = has('rubric');
const only = flag('members')?.split(',');
// Per-member, in minutes. A council of five is bounded by its slowest member, and 15 minutes was
// chosen for a model that thinks; a smaller budget is a legitimate choice on a smaller question.
const timeoutMin = Number(flag('timeout')) > 0 ? Number(flag('timeout')) : 15;

if (!question && !has('verify-delivery')) {
  console.error('Usage: council.mjs "<question>" [--context <file>...] [--events] [--lenses] [--rubric]');
  console.error('       council.mjs --verify-delivery       # prove each member actually receives its prompt');
  process.exit(1);
}

const scratch = CFG.scratchDir.replace('~', os.homedir());
fs.mkdirSync(scratch, { recursive: true });

const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  || 'council';

// ── the event stream, and the live view fed from it ──────────────────────────
//
// One source of truth. Every progress signal a human sees is derived from the same events a UI
// would consume, so the terminal cannot be right while the stream is wrong — the failure this
// arrangement is designed to make impossible.
const eventsPath = has('events')
  ? (flag('events') || path.join(OUT_DIR, `${slug}.events.ndjson`))
  : null;
const emitter = createEmitter({
  file: eventsPath,
  // fd 3 for a parent that wants the stream without a file. stderr is the human's, stdout is the
  // run-file path — a third channel is the only way to have all three without interleaving.
  toFd: has('json-events') ? 3 : null,
});
const render = createRenderer({ isTty: has('no-live') ? false : undefined });
const log = (s) => render.note(s);

/** Emit, and let the live view react to the same event. Nothing bypasses this. */
const ev = (name, data) => { emitter.emit(name, data); render.handle({ ev: name, ...data }); };

if (eventsPath && emitter.broken) {
  // Asked for and not delivered is a failure, not a detail. A UI waiting on a file that will never
  // appear looks exactly like a council that hung.
  console.error(`\n  --events was requested but the stream could not be opened: ${emitter.broken}\n`);
  process.exit(1);
}

// ── pre-flight ───────────────────────────────────────────────────────────────
//
// Find out who is here BEFORE spending anything. A member whose CLI is not installed used to be
// discovered mid-run, after the others had already started, and the failure arrived mixed in with
// real answers.
//
// **Nothing is ever retried.** A CLI that is missing now will be missing in thirty seconds, and a
// quota that is exhausted does not refill while you wait. Retrying would turn a clear answer — "you
// have four of five" — into an indefinite hang, which is the failure this whole section prevents.
function onPath(cmd) {
  const runnable = (f) => {
    // Existence is not enough: a non-executable file at the right path is reported as present and
    // then fails at spawn time, which is exactly the mid-run discovery pre-flight exists to avoid.
    try { fs.accessSync(f, fs.constants.X_OK); return !fs.statSync(f).isDirectory(); } catch { return false; }
  };
  if (cmd.includes('/')) return runnable(cmd);
  const dirs = [`${os.homedir()}/.local/bin`, `${os.homedir()}/.npm-global/bin`,
    '/usr/local/bin', '/opt/homebrew/bin', ...(process.env.PATH ?? '').split(':')];
  return dirs.some((d) => d && runnable(path.join(d, cmd)));
}

// ── containment, enforced rather than promised ───────────────────────────────
//
// The package's central claim is "members advise, they never edit." It was guarded by a test that
// pattern-matched flags for `/read-only|plan|--print|-p$/` — which passed while THREE of five members
// could write, because `--print` is an output format and a bare `-p` is a prompt flag. Neither is a
// permission. See scripts/verify-containment.mjs for the measurement and the two probes.
//
// So an uncontained member is excluded here, by default, loudly. A four-member council that keeps the
// promise is worth more than a five-member one that quietly breaks it — and including a writer is a
// decision for the user to make out loud, not one for this script to make on their behalf.
const allowUncontained = has('allow-uncontained');
const asked = CFG.members.filter((m) => !only || only.includes(m.id));
const uncontained = asked.filter((m) => m.contained === false);
const requested = allowUncontained ? asked : asked.filter((m) => m.contained !== false);
const members = requested.filter((m) => onPath(m.cmd));
const absent = requested.filter((m) => !onPath(m.cmd));

ev('run_start', {
  schema: SCHEMA,
  question,
  members: requested.map((m) => ({ id: m.id, label: m.label, family: m.family ?? 'unknown' })),
  flags: { lenses: useLenses, rubric: rubricMode, revise: has('revise'), stage1Only, timeoutMin, allowUncontained },
  excludedUncontained: allowUncontained ? [] : uncontained.map((m) => m.id),
});
ev('preflight', {
  available: members.map((m) => m.id),
  absent: absent.map((m) => ({ id: m.id, label: m.label, cmd: m.cmd })),
});

if (uncontained.length) {
  if (allowUncontained) {
    log(`\n▸ ⚠ RUNNING AN UNCONTAINED MEMBER because --allow-uncontained was passed:`);
    for (const m of uncontained) log(`    🚨 ${m.label} — measured able to write to any absolute path`);
    log(`    The pack you are sending is repository content. A file in it can carry an instruction`);
    log(`    aimed at whoever reads it next, and for this member nothing but the prompt stops it.`);
  } else {
    log(`\n▸ Excluded — cannot be prevented from writing, and this package promises otherwise:`);
    for (const m of uncontained) log(`    🚨 ${m.label} (verify with: node scripts/verify-containment.mjs --members=${m.id})`);
    log(`    Re-run with --allow-uncontained if you accept that. A smaller council that keeps its`);
    log(`    promise beats a larger one that does not.`);
  }
}

if (absent.length) {
  log(`\n▸ Not installed on this machine — skipped, not retried:`);
  for (const m of absent) log(`    ✗ ${m.label} (\`${m.cmd}\` not found, or not executable)`);
}

if (!members.length) {
  log(`\n  No council member is available on this machine.`);
  log(`  Requested: ${requested.map((m) => m.cmd).join(', ')}`);
  log(`\n  Install one, or run with --members=<id> for those you do have.`);
  log(`  Nothing was spent and nothing was written.\n`);
  ev('run_done', { ok: false, answered: 0, requested: requested.length, file: null, exitCode: 2 });
  emitter.close(); render.finish();
  process.exit(2);   // 2 = could not convene, distinct from 1 = convened and all failed
}

if (has('preflight')) {
  log(`\n  ${members.length}/${requested.length} member(s) available: ${members.map((m) => m.label).join(', ')}`);
  log(`  Prompt delivery: ${members.map((m) => `${m.id}=${deliveryOf(m)}`).join(', ')}`);
  log('  Pre-flight only — nothing was run.\n');
  ev('run_done', { ok: true, answered: 0, requested: requested.length, file: null, exitCode: 0 });
  emitter.close(); render.finish();
  process.exit(0);
}

// ── a seeded shuffle, so a run is reproducible but position bias is not shared ────
const seedNum = (s) => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 12), 16);

function shuffled(arr, seedStr) {
  let h = seedNum(seedStr);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) % 2147483648;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── the heartbeat ────────────────────────────────────────────────────────────
//
// One timer for the whole run rather than one per member: five timers producing five interleaved
// streams of ticks is the same information at five times the volume, and a UI then has to
// reassemble what the parent already knew.
//
// Unref'd, so it can never be the reason node stays alive — the bug this file has a whole section
// about, reintroduced by the progress indicator, would be a poor trade.
const live = new Map();          // id → {member, stage, started, bytes, lastLine}
const ticker = setInterval(() => {
  for (const [id, s] of live) {
    ev('member_tick', {
      stage: s.stage, id,
      elapsedMs: Date.now() - s.started,
      bytes: s.bytes,
      lastLine: s.lastLine,
    });
  }
}, 1000);
ticker.unref?.();

/**
 * Run one member. **Never rejects, and never leaves the process hanging.**
 *
 * A council of four beats a council that died, so a failure here is a result rather than an
 * exception — including a prompt that cannot be delivered, which is now decided before spawn
 * instead of arriving as an E2BIG from deep inside libuv.
 *
 * And it must not be able to hold the run open: a child that ignores SIGTERM kept the parent's
 * event loop alive after the promise had already resolved — the council finished and the process sat
 * there. SIGKILL follows, and the child is unref'd so node can exit.
 */
function ask(member, prompt, { stage = '1' } = {}) {
  const started = Date.now();
  const timeoutMs = timeoutMin * 60_000;
  const done = (ok, text, extra = {}) => {
    const r = { id: member.id, label: member.label, ok, text: String(text).trim(), ms: Date.now() - started, ...extra };
    ev('member_done', { stage, id: member.id, label: member.label, ok: r.ok, ms: r.ms, chars: r.text.length, reason: ok ? undefined : r.text.slice(0, 120) });
    return r;
  };

  const plan = prepare(member, prompt, scratch);
  ev('member_start', { stage, id: member.id, label: member.label, promptChars: prompt.length, via: plan.via });

  // A member that cannot be handed this prompt is reported like any other failure. Named, with the
  // reason and the remedy, before a single token is spent.
  if (!plan.ok) return Promise.resolve(done(false, plan.reason));

  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    const state = { member, stage, started, bytes: 0, lastLine: '' };
    live.set(member.id, state);

    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      live.delete(member.id);
      plan.cleanup();
      resolve(done(ok, text));
    };

    let p;
    try {
      // `detached: true` puts the child in its own process GROUP, so the timeout can kill
      // everything it spawned rather than only the process we can see.
      //
      // Found by testing: killing the child left its grandchild alive, still holding the inherited
      // stdout pipe, so the parent's event loop never drained and the run hung anyway — 15s instead
      // of the 329ms the earlier fix had achieved. Every member here is a CLI that shells out, so
      // this is the normal case rather than an edge one.
      p = spawn(member.cmd, plan.args, {
        cwd: scratch,
        stdio: [plan.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      finish(false, `could not start ${member.cmd}: ${e.message}`);
      return;
    }

    if (plan.stdin !== null) {
      // EPIPE here means the child exited before reading the prompt — a result, not a crash. The
      // close handler will report whatever it managed to say.
      p.stdin.on('error', () => {});
      p.stdin.end(plan.stdin);
    }

    p.stdout.on('data', (d) => {
      out += d;
      state.bytes = out.length;
      // The last non-empty line, for the heartbeat. Capped and scrubbed by `redactLine`, because a
      // child can print anything — including a fragment of the pack it was just handed.
      const lines = out.split('\n').filter((l) => l.trim());
      if (lines.length) state.lastLine = redactLine(lines[lines.length - 1]);
    });
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('error', () => {});          // EPIPE if the child dies mid-write
    p.stderr.on('error', () => {});
    p.on('error', (e) => finish(false, `could not start ${member.cmd}: ${e.message}`));
    p.on('close', (c) => finish(...judgeOutput(out, err, c)));

    // Kill the whole group (negative pid), falling back to the single process if the group is
    // already gone. SIGTERM is a request; SIGKILL five seconds later is not.
    const stop = (sig) => {
      try { process.kill(-p.pid, sig); } catch {
        try { p.kill(sig); } catch { /* already gone */ }
      }
    };

    const t = setTimeout(() => {
      stop('SIGTERM');
      const hard = setTimeout(() => {
        stop('SIGKILL');
        // Detach the streams too: a grandchild we failed to reach must not keep the event loop
        // alive through an inherited pipe.
        try { p.stdout.destroy(); p.stderr.destroy(); p.unref(); } catch { /* gone */ }
      }, 5_000);
      hard.unref?.();
      finish(false, `timed out after ${timeoutMin} min`);
    }, timeoutMs);
    t.unref?.();
    p.on('close', () => clearTimeout(t));
  });
}

// ── --verify-delivery ────────────────────────────────────────────────────────
//
// The one check that catches a silent wrong answer rather than a loud failure.
//
// A member whose `promptVia` is wrong does not error. `agy` handed a prompt on stdin exits 0 and
// replies "How can I help you today?" — a fluent answer to a question it never received, which then
// goes into the anonymised peer review and is ranked against real answers. Nothing downstream can
// tell that apart from a member that simply disagreed.
//
// So: a unique canary per member, and the only passing condition is that the token comes back.
// Costs one trivial call each and is the cheapest insurance in this repo.
if (has('verify-delivery')) {
  log(`\n▸ Verifying that each member actually RECEIVES its prompt.`);
  log(`  A wrong delivery channel does not error — it answers an empty question fluently.\n`);
  const results = await Promise.all(members.map(async (m) => {
    const c = canary();
    const r = await ask(m, c.prompt, { stage: 'verify' });
    return { m, ok: r.ok && c.arrived(r.text), r, via: deliveryOf(m) };
  }));
  log('');
  for (const { m, ok, r, via } of results) {
    log(`  ${ok ? '✅' : '❌'} ${m.label.padEnd(30)} via ${via.padEnd(6)} ${ok ? 'canary returned' : `NO CANARY — "${r.text.slice(0, 60)}"`}`);
  }
  const bad = results.filter((x) => !x.ok);
  if (bad.length) {
    log(`\n  ${bad.length} member(s) did not return the canary. Their prompt is not arriving —`);
    log(`  fix promptVia in the roster before trusting anything they say.\n`);
  } else {
    log(`\n  All ${results.length} receive their prompt.\n`);
  }
  ev('run_done', { ok: !bad.length, answered: results.length - bad.length, requested: results.length, file: null, exitCode: bad.length ? 1 : 0 });
  emitter.close(); render.finish();
  process.exit(bad.length ? 1 : 0);
}

if (members.length < requested.length) {
  log(`\n  Continuing with ${members.length} of ${requested.length}. A smaller council is a`);
  log('  weaker one — fewer independent readers, and the tally means less.');
}

// ── context ──────────────────────────────────────────────────────────────────
const ctx = buildContext(ctxFiles, ROOT);
const ctxTok = Math.round(ctx.chars / 4);
const brief = loadBrief(ROOT);

// The budget is shown every run, because the failure at the ceiling is silent: at ~80k one member
// stopped following instructions rather than erroring. Measured 2026-07-28.
log(`\n▸ Context — ${ctx.files.length} file(s), ~${(ctxTok / 1000).toFixed(1)}k tokens `
  + `of ~40k budget${ctxTok > 27_000 ? '  ⚠ past the size every member was verified obedient at' : ''}`);
for (const f of ctx.files) log(`    + ${f}`);
for (const r of ctx.refused) log(`    ✗ ${r}`);
if (!ctx.files.length) {
  log('    ⚠ No context passed. The members cannot see this repo. For any question about');
  log('      THIS codebase, pass --context <files> or you will get five informed guesses.');
}

if (brief.source) log(`▸ Brief    — ${brief.source}`);
else log('▸ Brief    — none found. Write .council/BRIEF.md or AGENTS.md; it is the cheapest quality win available.');

ev('context', {
  files: ctx.files, refused: ctx.refused, chars: ctx.chars, tokens: ctxTok,
  budgetTokens: 40_000, briefSource: brief.source,
});

const preamble = [brief.text, ctx.text].filter(Boolean).join('\n\n---\n\n');
// Everything every member was handed. `reasoningOverlap` subtracts this vocabulary out, so shared
// identifiers from the pack are not counted as shared reasoning.
const packText = `${preamble}\n${question}`;

// An argv-only member cannot carry an arbitrarily large prompt, and the limit is the platform's, not
// ours. Warned here — before the spend — rather than discovered per-member later, because the remedy
// (fewer files, or drop the member) has to be applied to the whole run.
const argvOnly = members.filter((m) => deliveryOf(m) === 'argv');
if (argvOnly.length) {
  const est = preamble.length + question.length + 2_000;
  const ceiling = argvCeiling();
  log(`\n▸ Delivery — ${argvOnly.map((m) => m.label).join(', ')} can only be given the prompt through argv.`);
  log(`             ~${est.toLocaleString()} chars against this platform's ~${ceiling.toLocaleString()} limit`
    + `${est > ceiling * 0.8 ? '  ⚠ close to it' : ''}`);
  if (est > ceiling) log(`             ⚠ over the limit — ${argvOnly.map((m) => m.id).join(', ')} will be refused rather than crash`);
  log(`             Their prompt is also visible in the process table while they run.`);
}

// ── lenses ───────────────────────────────────────────────────────────────────
const lenses = useLenses ? P.assignLenses(members.map((m) => m.id), seedNum(question)) : {};
if (useLenses) {
  log(`\n▸ Lenses   — each member is given a different reasoning method (unmeasured; see prompts.mjs)`);
  for (const m of members) log(`    ${m.label.padEnd(30)} ${lenses[m.id].name}`);
}

// ── Stage 1 ──────────────────────────────────────────────────────────────────
const stageLabel = rubricMode ? '1 (rubric)' : '1';
ev('stage_start', { stage: stageLabel, members: members.map((m) => m.id), hint: 'in parallel. Minutes, not seconds.' });

const opinions = await Promise.all(members.map((m) => ask(m,
  rubricMode
    ? P.rubric(preamble, question, question)
    : P.stage1(preamble, question, lenses[m.id]),
  { stage: stageLabel })));

ev('stage_done', { stage: stageLabel, ok: opinions.filter((o) => o.ok).length, failed: opinions.filter((o) => !o.ok).length });

let good = opinions.filter((o) => o.ok);
if (!good.length) {
  log('\n  Every member failed.');
  for (const o of opinions) log(`    · ${o.label.padEnd(30)} ${o.text.split('\n')[0].slice(0, 80)}`);
  ev('run_done', { ok: false, answered: 0, requested: requested.length, file: null, exitCode: 1 });
  emitter.close(); render.finish();
  process.exit(1);
}

// ── Stage 1b · revision, opt-in ──────────────────────────────────────────────
//
// Mixture-of-Agents (arXiv 2406.04692) reports the effect this exploits: a model given other
// models' answers produces a better one than it did alone. That is a second full round — five more
// calls, minutes each — so it is behind a flag rather than on by default.
//
// The revised answers replace the originals for ranking. The originals stay in the file, because
// "what changed once they saw each other" is often the most informative thing in it.
let revised = null;
if (has('revise') && good.length > 1) {
  ev('stage_start', { stage: '1b', members: good.map((o) => o.id), hint: 'revision — each sees the others and answers again' });
  const board = good.map((o, i) => `### Response ${String.fromCharCode(65 + i)}\n\n${o.text}`).join('\n\n---\n\n');
  revised = await Promise.all(good.map(async (o) => {
    const m = members.find((x) => x.id === o.id);
    const r = await ask(m, P.stage1b(preamble, question, board, lenses[o.id]), { stage: '1b' });
    return r.ok ? r : o;
  }));
  ev('stage_done', { stage: '1b', ok: revised.filter((o) => o.ok).length, failed: 0 });
  good = revised;
}

// ── Stage 2 — anonymised, per-reviewer order, machine-parseable ranking ───────
// `parseRanking` lives in diagnostics.mjs so the tests can import the real thing instead of
// reimplementing it — the test file used to keep its own copy, which pins the behaviour but cannot
// catch this file drifting away from it.
let reviews = [];
let tally = null;

// Rubric mode aggregates scores rather than rankings, so peer review is off unless asked for: a
// ranking of five reviews answers "which review was best", which is not the question a rubric run
// was convened to settle. `--rubric --revise` is the second pass worth paying for.
const wantPeerReview = !stage1Only && good.length > 1 && (!rubricMode || has('peer-review'));

if (wantPeerReview) {
  ev('stage_start', { stage: '2', members: good.map((o) => o.id), hint: 'anonymised peer review, each reviewer sees its own ordering' });

  reviews = await Promise.all(good.map(async (o) => {
    // A distinct permutation per reviewer: position bias no longer points the same way for
    // everyone, so it shows up as disagreement instead of as a shared, invisible tilt.
    const order = shuffled(good, `${question}::${o.id}`);
    const letters = order.map((_, i) => String.fromCharCode(65 + i));
    const mine = letters[order.findIndex((x) => x.id === o.id)];
    const body = order.map((x, i) => `### Response ${letters[i]}\n\n${x.text}`).join('\n\n---\n\n');

    const r = await ask(members.find((m) => m.id === o.id), P.stage2(preamble, question, body), { stage: '2' });

    // Map this reviewer's letters back to member ids before the permutation is forgotten. A label
    // that was never offered to this reviewer is dropped here rather than in the parser — the
    // parser cannot know which letters this permutation used.
    const parsed = rankedLabels(r.text)
      .filter((L) => letters.includes(L))
      .map((L) => order[letters.indexOf(L)]?.id)
      .filter(Boolean);

    const minority = r.text.match(/^[^\S\n]*MINORITY VIEW WORTH KEEPING:\s*(.+)$/im)?.[1]?.trim();
    const lost = r.text.match(/^[^\S\n]*WHAT IS LOST IF THE TOP ANSWER WINS:\s*(.+)$/im)?.[1]?.trim();

    return { ...r, mine, order: order.map((x) => x.id), parsed, minority, lost };
  }));
  ev('stage_done', { stage: '2', ok: reviews.filter((r) => r.ok).length, failed: reviews.filter((r) => !r.ok).length });

  const ids = good.map((o) => o.id);
  const b = borda(reviews, ids);
  const lengths = Object.fromEntries(good.map((o) => [o.id, o.text.length]));
  tally = {
    ...b,
    lengths,
    lengthR: verbosityR(b.scores, lengths),
    families: familyMix(good.map((o) => members.find((m) => m.id === o.id) ?? { family: 'unknown' })),
  };
  ev('tally', { scores: tally.scores, counted: tally.counted, selfFirst: tally.selfFirst,
    selfN: tally.selfN, selfMean: tally.selfMean, lengthR: tally.lengthR, families: tally.families });
}

// ── the numbers that do not need a peer-review stage ─────────────────────────
const overlap = reasoningOverlap(good.map((o) => ({ id: o.id, text: o.text })), packText);
const confidences = Object.fromEntries(good.map((o) => [o.id, parseConfidence(o.text)]));
const rubricPerJudge = rubricMode
  ? good.map((o) => ({ id: o.id, label: o.label, ...parseRubric(o.text) }))
  : null;
const rubricAgg = rubricMode ? aggregateScores(rubricPerJudge) : null;

if (rubricMode) {
  ev('tally', {
    rubric: true,
    overall: rubricAgg.overall,
    dimensions: Object.fromEntries(Object.entries(rubricAgg.dimensions).map(([k, v]) => [k, v.median])),
  });
}

// ── the record ───────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${slug}.md`);
const byId = Object.fromEntries(good.map((o) => [o.id, o.label]));

const pct = (x) => `${Math.round(100 * x)}%`;
const confLine = (id) => {
  const c = confidences[id];
  if (!c || c.confidence === null) return '_did not state a confidence_';
  return `**${c.confidence}%**${c.changeMind ? ` — would change its mind if: ${c.changeMind}` : ''}`;
};

const md = [
  `# Council — ${question}`,
  ``,
  `> ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${good.length}/${members.length} answered`
    + `${useLenses ? ' · lensed' : ''}${rubricMode ? ' · rubric' : ''}`,
  ...(ctx.files.length
    ? [`> **Context:** ${ctx.files.map((f) => `\`${f}\``).join(', ')} — ~${ctxTok} tokens`]
    : [`> **No context was passed.** Every answer below is reasoning about code the members could not read.`]),
  ...(ctx.refused.length ? [`> **Refused:** ${ctx.refused.join('; ')}`] : []),
  ...(eventsPath ? [`> **Event stream:** \`${path.relative(ROOT, eventsPath)}\``] : []),
  // Recorded in the file, not only in the terminal. Someone reading this run in three months has to
  // be able to tell whether a member that can write to any path was in the room.
  ...(uncontained.length && allowUncontained
    ? [`> **🚨 An uncontained member took part:** ${uncontained.map((m) => m.label).join(', ')} — measured able to write to any absolute path. \`--allow-uncontained\` was passed.`]
    : []),
  ...(uncontained.length && !allowUncontained
    ? [`> **Excluded as uncontained:** ${uncontained.map((m) => m.label).join(', ')} — cannot be prevented from writing.`]
    : []),
  ``,

  // ── rubric scores, when that is what was asked for ──
  ...(rubricAgg ? [
    `## Score — median of ${rubricAgg.overall?.n ?? 0} judges`,
    ``,
    rubricAgg.overall
      ? `### Overall: **${rubricAgg.overall.median.toFixed(1)}/10**  (range ${rubricAgg.overall.min}–${rubricAgg.overall.max}, n=${rubricAgg.overall.n})`
      : `### Overall: no judge produced a parseable \`OVERALL: n/10\``,
    ``,
    `| Dimension | Median | Range | n |`,
    `|---|---|---|---|`,
    ...Object.entries(rubricAgg.dimensions)
      .sort((a, b) => a[1].median - b[1].median)
      .map(([d, v]) => `| ${d} | **${v.median.toFixed(1)}** | ${v.min}–${v.max} | ${v.n} |`),
    ``,
    `**Median, not mean, and the range is beside it on purpose.** One agreeable judge cannot lift`,
    `this and one harsh judge cannot sink it — but a wide range means the judges did not agree, and`,
    `a median of 9 from 4,4,9,9,9 must not read like a median of 9 from 8,9,9,9,9. **Read the range`,
    `before the median.** Dimensions are sorted worst-first, because that is the work.`,
    ``,
    `| Judge | Overall | Confidence |`,
    `|---|---|---|`,
    ...rubricPerJudge.map((j) => `| ${j.label} | ${j.overall ?? '—'} | ${confidences[j.id]?.confidence ?? '—'} |`),
    ``,
  ] : []),

  ...(tally ? [
    `## Aggregate — Borda over ${tally.counted}/${tally.total} rankings, **self-votes excluded**`,
    ``,
    `| Member | Score | Answer length | Confidence |`,
    `|---|---|---|---|`,
    ...Object.entries(tally.scores).sort((a, b) => b[1] - a[1])
      .map(([id, s]) => `| ${byId[id]} | ${s} | ${tally.lengths[id]} chars | ${confidences[id]?.confidence ?? '—'} |`),
    ``,
  ] : []),

  // ── the diagnostics, printed whether or not there was a ranking ──
  `### Diagnostics — read these before any score above`,
  ``,
  `| | This run | Unbiased / expected | |`,
  `|---|---|---|---|`,
  ...(tally ? [
    `| **Self-enhancement** — judges ranking their own answer 1st | ${tally.selfN ? `${tally.selfFirst}/${tally.selfN} (${Math.round(100 * tally.selfFirst / tally.selfN)}%)` : 'n/a'} | ${Math.round(100 / good.length)}% | ${tally.selfN && tally.selfFirst / tally.selfN > 1.5 / good.length ? '⚠ present' : 'ok'} |`,
    `| **Mean self-rank** | ${tally.selfMean ? tally.selfMean.toFixed(1) : 'n/a'} | ${((good.length + 1) / 2).toFixed(1)} | |`,
    `| **Verbosity** — correlation(score, answer length) | ${tally.lengthR.toFixed(2)} | 0.00 | ${Math.abs(tally.lengthR) > 0.5 ? '⚠ length is doing work' : 'ok'} |`,
    `| **Family mix** | ${Object.entries(tally.families).map(([f, n]) => `${f} ${n}`).join(', ')} | even | ${Math.max(...Object.values(tally.families)) > good.length / 2 ? '⚠ one family has a majority' : 'ok'} |`,
  ] : [
    `| **Family mix** | ${Object.entries(familyMix(good.map((o) => members.find((m) => m.id === o.id) ?? { family: 'unknown' }))).map(([f, n]) => `${f} ${n}`).join(', ')} | even | |`,
  ]),
  `| **Reasoning overlap** — shared vocabulary with the pack's own terms removed | ${overlap.distinctive === null ? `n/a — ${overlap.thin ? 'answers too short to measure' : 'fewer than two answers'}` : overlap.distinctive.toFixed(2)} | lower is more independent | ${overlap.distinctive !== null && overlap.distinctive > OVERLAP_SUSPECT ? '⚠ they may be one argument, not five' : 'ok'} |`,
  `| **Raw overlap** — before removing the pack's vocabulary | ${overlap.raw === null ? 'n/a' : overlap.raw.toFixed(2)} | — | shown so the correction is visible |`,
  `| **Confidence** — members stating one | ${Object.values(confidences).filter((c) => c.confidence !== null).length}/${good.length} | ${good.length}/${good.length} | |`,
  `| **Mean confidence** | ${(() => { const v = Object.values(confidences).map((c) => c.confidence).filter((x) => x !== null); return v.length ? `${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}%` : 'n/a'; })()} | — | ${(() => { const v = Object.values(confidences).map((c) => c.confidence).filter((x) => x !== null); return v.length && v.reduce((a, b) => a + b, 0) / v.length < 65 ? '⚠ agreement at low confidence is a request for more context' : 'ok'; })()} |`,
  ``,
  ...(tally ? [
    `**Self-votes are excluded from the score above.** They were measured on the first real run and`,
    `they dominate: 3 of 4 judges ranked their own unlabelled answer first — 75% against a 20%`,
    `chance rate. **Anonymisation does not prevent self-enhancement**; a model recognises its own`,
    `writing. Every answer is still judged by ${good.length - 1} independent `
      + `${good.length - 1 === 1 ? 'reader' : 'readers'}.`,
    ``,
  ] : []),
  `**Reasoning overlap is the new one, and it is what "consensus is not correctness" actually`,
  `measures.** Every member is handed the same pack, so five answers about the same file share its`,
  `identifiers no matter how independently they were written — raw similarity mostly measures the`,
  `question. The number above removes every term that appeared in the pack, the brief or the`,
  `question first, and compares only the vocabulary each member brought itself. **The ${OVERLAP_SUSPECT}`,
  `threshold is borrowed from council-review and is not validated on this council** — treat it as`,
  `indicative, in the same way the verbosity correlation is (it swung 0.64 / −0.18 / 0.53 / 0.06`,
  `across four runs, which is why it is printed rather than corrected).`,
  ``,
  `**Even clean, a tally is a popularity number.** Models on overlapping training data agreeing`,
  `is weak evidence. Use it to find *where they split*, never to pick the winner.`,
  ``,
  ...(useLenses ? [
    `**Lenses were on.** Each member was given a different reasoning method — inversion, first`,
    `principles, analogy, naive outsider, execution order — so a shared conclusion had to be reached`,
    `by different routes. Whether this improves answers **has not been measured**; the reasoning-`,
    `overlap number above is the instrument it would be measured with.`,
    ``,
    `| Member | Lens |`,
    `|---|---|`,
    ...members.filter((m) => byId[m.id]).map((m) => `| ${m.label} | ${lenses[m.id].name} |`),
    ``,
  ] : []),
  `---`,
  ``,

  // ── rubric findings, gathered where they can be acted on ──
  ...(rubricPerJudge ? [
    `## Findings`,
    ``,
    `Each judge's own words. **A finding named by one judge is not weaker than one named by four** —`,
    `four judges missing something is the normal case, and a defect only one reader found is`,
    `precisely what a council is for.`,
    ``,
    ...rubricPerJudge.flatMap((j) => {
      const src = good.find((o) => o.id === j.id);
      const blocks = [...(src?.text ?? '').matchAll(/^[^\S\n]*FINDING:\s*(.+)$/gim)].map((m) => m[1].trim());
      return [
        `### ${j.label} — overall ${j.overall ?? '—'}/10, confidence ${confidences[j.id]?.confidence ?? '—'}`,
        ``,
        ...(blocks.length ? blocks.map((b) => `- ${b}`) : ['_no parseable FINDING: lines — see its full answer below_']),
        ``,
        ...(src?.text.match(/^[^\S\n]*SINGLE BIGGEST WIN:\s*(.+)$/im)
          ? [`**Biggest win, in its view:** ${src.text.match(/^[^\S\n]*SINGLE BIGGEST WIN:\s*(.+)$/im)[1].trim()}`, ``]
          : []),
      ];
    }),
    `---`,
    ``,
  ] : []),

  revised ? `## Stage 1 — first opinions (revised versions follow)` : `## Stage 1 — independent opinions`,
  ``,
  ...opinions.flatMap((o) => [
    `### ${o.label}${o.ok ? '' : ' — FAILED'}${useLenses && lenses[o.id] ? ` · ${lenses[o.id].name}` : ''}`, ``,
    `*${Math.round(o.ms / 1000)}s · confidence ${o.ok ? confLine(o.id) : 'n/a'}*`, ``,
    o.ok ? o.text : `> ${o.text}`, ``, `---`, ``,
  ]),
  ...(revised ? [
    `## Stage 1b — after seeing each other`,
    ``,
    `Mixture-of-Agents: a model given the others' answers produces a better one. **What changed is`,
    `the signal** — a member that reversed itself here is worth more attention than one that`,
    `restated its first answer at greater length.`,
    ``,
    ...revised.flatMap((o) => [`### ${o.label}`, ``, o.text, ``, `---`, ``]),
  ] : []),
  ...(reviews.length ? [
    `## Stage 2 — anonymised peer review`,
    ``,
    `**Each reviewer saw its own ordering**, seeded from the question. So position bias does not`,
    `point the same way for everyone — where it exists, it surfaces as disagreement instead of as a`,
    `shared tilt nobody can see. The mapping below de-anonymises after the fact.`,
    ``,
    ...(reviews.some((r) => r.minority || r.lost) ? [
      `### What a ranking cannot carry`,
      ``,
      `Pulled out because a synthesis destroys it first. **The minority view is often the correct one**`,
      `— it is the only reading that did not follow the obvious path.`,
      ``,
      ...reviews.filter((r) => r.minority || r.lost).flatMap((r) => [
        `- **${r.label}** — minority view worth keeping: ${r.minority ?? '_none stated_'}`,
        ...(r.lost ? [`  · lost if the top answer wins: ${r.lost}`] : []),
      ]),
      ``,
    ] : []),
    ...reviews.flatMap((r) => [
      `### ${r.label}${r.ok ? '' : ' — FAILED'}`,
      ``,
      `*saw itself as ${r.mine} · order: ${r.order.map((id, i) => `${String.fromCharCode(65 + i)}=${byId[id] ?? id}`).join(', ')}*`,
      ...(r.ok && r.parsed.length < 2 ? [``, `> ⚠ No parseable \`FINAL RANKING:\` block — excluded from the tally.`] : []),
      ``, r.ok ? r.text : `> ${r.text}`, ``, `---`, ``,
    ]),
  ] : []),
  `## For the chairman`,
  ``,
  `1. **Where they disagree is the output.** Record both sides; averaging the members produces`,
  `   something none of them would defend.`,
  `2. **Consensus is not correctness** — and the reasoning-overlap number above tells you how much`,
  `   of this run's agreement was five arguments rather than one.`,
  `3. **A minority view may be overruled, but say what it cost.** If you side with the majority`,
  `   against a specific dissent, name the dissent and why.`,
  `4. **Every number goes through your own verification**, however many members said it.`,
  `5. **Weigh by confidence, not only by count.** Five members agreeing at 55% is a request for more`,
  `   context, not a decision.`,
  ...(ctx.files.length ? [] : [
    `6. **⚠ No context was passed to this council.** Before using any of it, ask whether the answer`,
    `   would survive the members actually reading the code.`,
  ]),
  ``,
].join('\n');

fs.writeFileSync(file, md);

// A structured sibling of the markdown, for anything that is not a human. The markdown is the
// record; this is the same run in a shape a UI, a diff, or a later measurement can index without
// parsing prose.
const jsonFile = file.replace(/\.md$/, '.json');
fs.writeFileSync(jsonFile, `${JSON.stringify({
  schema: SCHEMA,
  question,
  at: new Date().toISOString(),
  flags: { lenses: useLenses, rubric: rubricMode, revise: has('revise'), stage1Only, timeoutMin },
  context: { files: ctx.files, refused: ctx.refused, tokens: ctxTok, brief: brief.source },
  members: requested.map((m) => ({ id: m.id, label: m.label, family: m.family ?? 'unknown', via: deliveryOf(m), present: members.includes(m) })),
  opinions: opinions.map((o) => ({ id: o.id, ok: o.ok, ms: o.ms, chars: o.text.length, lens: lenses[o.id]?.id ?? null, ...confidences[o.id] })),
  reviews: reviews.map((r) => ({ id: r.id, ok: r.ok, ms: r.ms, parsed: r.parsed, minority: r.minority ?? null, lost: r.lost ?? null })),
  tally, overlap, rubric: rubricAgg, rubricPerJudge,
}, null, 2)}\n`);

// ── the report the caller actually needs ─────────────────────────────────────
//
// Printed at the end, in one place, rather than scattered through the run. Someone who looked away
// for ten minutes should be able to tell in one glance whether this council is worth reading — and a
// degraded one must say so rather than presenting four answers as five.
const failed = opinions.filter((o) => !o.ok);
render.finish();
log(`\n${'─'.repeat(64)}`);
log(`  ${good.length}/${requested.length} answered.`);

if (rubricAgg?.overall) {
  log(`\n  Score: ${rubricAgg.overall.median.toFixed(1)}/10  (median of ${rubricAgg.overall.n}, range ${rubricAgg.overall.min}–${rubricAgg.overall.max})`);
  const worst = Object.entries(rubricAgg.dimensions).sort((a, b) => a[1].median - b[1].median)[0];
  if (worst) log(`  Weakest dimension: ${worst[0]} at ${worst[1].median.toFixed(1)}/10`);
}

if (overlap.distinctive !== null) {
  log(`\n  Reasoning overlap: ${overlap.distinctive.toFixed(2)}`
    + `${overlap.distinctive > OVERLAP_SUSPECT ? '  ⚠ high — check whether this is one argument told five times' : ''}`);
}

if (absent.length) {
  log(`\n  Not installed — skipped:`);
  for (const m of absent) log(`    · ${m.label.padEnd(30)} \`${m.cmd}\` not on this machine`);
}
if (failed.length) {
  log(`\n  Ran and did not answer — reported, not retried:`);
  for (const f of failed) log(`    · ${f.label.padEnd(30)} ${f.text.split('\n')[0].slice(0, 60)}`);
}

if (good.length < 2) {
  log(`\n  ⚠  Only ${good.length} member answered, so there was no peer review and no tally.`);
  log('     Treat what follows as one opinion, not a council.');
} else if (good.length < requested.length) {
  log(`\n  ⚠  A ${good.length}-member council. Fewer independent readers than intended —`);
  log('     the disagreements still matter; the score means less.');
}

log(`\n▸ Written: ${path.relative(ROOT, file)}`);
log(`           ${path.relative(ROOT, jsonFile)}`);
if (eventsPath) log(`           ${path.relative(ROOT, eventsPath)}`);
log('');

ev('run_done', {
  ok: true, answered: good.length, requested: requested.length,
  file: path.relative(ROOT, file), exitCode: 0,
  score: rubricAgg?.overall?.median ?? null,
});
clearInterval(ticker);
emitter.close();
render.finish();

console.log(file);

// 0 = usable (even if degraded) · 1 = convened and nobody answered · 2 = could not convene.
process.exit(good.length ? 0 : 1);
