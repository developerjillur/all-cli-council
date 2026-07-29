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
//        [--stage1-only] [--revise] [--members=id,id] [--lenses] [--rubric] [--peer-review]
//        [--events[=path]] [--json-events] [--no-live] [--timeout=<min>]
//        [--preflight] [--verify-delivery] [--allow-uncontained] [--local-roster]
//
//   node scripts/verify-containment.mjs        prove no member can write. Exit 3 if one can.
//   node scripts/watch.mjs                    follow a run's event stream from anywhere

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildContext, loadBrief, VERIFIED_OBEDIENT_TOKENS } from './context.mjs';
import { judgeOutput } from './judge-output.mjs';
import { createEmitter, redactLine, SCHEMA } from './events.mjs';
import { checkWritable, safeWrite, mkdirpSafe } from './safe-write.mjs';
import { createRenderer } from './render.mjs';
import { prepare, deliveryOf, canary, argvCeiling } from './prompt-delivery.mjs';
import { borda, verbosityR, familyMix, reasoningOverlap, parseConfidence, parseRubric,
  aggregateScores, rankedLabels, shuffled, seedNum, familyMajority, labelled, labelledAll,
  OVERLAP_SUSPECT } from './diagnostics.mjs';
import * as P from './prompts.mjs';
import { parseArgs, without, FLAGS } from './args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, '.council', 'runs');

// ── the roster, and why a repo is no longer allowed to supply one silently ────
//
// **This was arbitrary command execution, reachable by cloning a repository.**
//
// A `.council/members.json` in the working directory used to be loaded in preference to the packaged
// one, with no opt-in. Every field in it is attacker-controlled: `cmd` and `args` are what gets
// spawned, `scratchDir` is where, and `contained: true` is the flag that tells this script the member
// cannot write files. So `git clone`, then run a council in that repo — which the skill will do by
// itself when a decision looks expensive to reverse — and the repo chooses the command.
//
// It is worse than an ordinary config-injection bug because the containment check is *also* in the
// file being trusted. A hostile roster declares itself contained and the guard that would have
// excluded it reads the attacker's answer to its own question.
//
// Two rules, and the second is the one that matters:
//
//   1. A repo-local roster is used only when explicitly asked for (`--local-roster`).
//   2. **`contained` is never honoured from a repo-local roster.** Containment is something
//      `verify-containment.mjs` demonstrates, not something a file claims. Members from a local
//      roster are treated as uncontained, so `--allow-uncontained` is also required to run them.
//
// The packaged roster keeps its `contained` values, because those were measured and it ships with
// the code rather than with the user's data.
const localRoster = path.join(ROOT, '.council', 'members.json');
const wantsLocal = process.argv.includes('--local-roster');
const hasLocal = fs.existsSync(localRoster);
const usingLocal = hasLocal && wantsLocal;
const rosterPath = usingLocal ? localRoster : path.join(HERE, 'members.json');

let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
} catch (e) {
  console.error(`\n  Could not read the roster at ${rosterPath}: ${e.message}\n`);
  process.exit(2);
}
if (!Array.isArray(CFG.members) || !CFG.members.length) {
  console.error(`\n  The roster at ${rosterPath} has no members array.\n`);
  process.exit(2);
}

if (usingLocal) {
  // Stripped before anything reads it, so no later code path can be fooled by a value that came from
  // the repo, and then explicitly set to `false` — not left absent. The comment here used to claim it
  // was left absent, which was wrong in a way that mattered: `false` is what makes it show up in the
  // `uncontained` list and get NAMED in the output, where an absent field would only have failed the
  // `=== true` check silently. Fail-closed either way; loud is better.
  CFG.members = CFG.members.map(({ contained, containmentVerified, ...m }) => ({ ...m, contained: false }));
}

// A local roster that exists but was NOT opted into has to be mentioned. Silently ignoring a file
// the user wrote is its own bug, and the reason for ignoring it is worth stating once.
const localRosterIgnored = hasLocal && !wantsLocal;

// Asking for something that is not there deserves an answer. `--local-roster` with no
// `.council/members.json` silently used the packaged roster, so a user who had mistyped the path — or
// was in the wrong directory — got a normal-looking run against a roster they did not choose.
if (wantsLocal && !hasLocal) {
  console.error(`\n  --local-roster was passed but ${path.relative(ROOT, localRoster)} does not exist.`);
  console.error('  Refusing rather than silently using the packaged roster, which is not what you asked for.\n');
  process.exit(2);
}

// ── arguments ────────────────────────────────────────────────────────────────
//
// Parsed ONCE, against a declared schema, in scripts/args.mjs. It used to be three ad-hoc helpers
// over `process.argv` that had no idea what the flags were — and every disagreement between "how a
// flag is spelled" and "how it is read" became a silent wrong behaviour. Four defects, one root:
//
//   · `--detach=1` was a FORK BOMB — the `=` form matched the switch check but the child argv was
//     built by removing only the bare token, so the child re-detached, without end
//   · `--context=a.js` passed the known-flag check and was then discarded, running a council with
//     ZERO context — what this package's own README calls "five informed guesses"
//   · `--timeout=abc` silently became the 15-minute default
//   · a typo'd `--members=codx` said "install one" instead of "no such member"
//
// The parser refuses instead of guessing, and a boolean given a value is an error rather than a
// truthy string — that single rule is what makes the fork bomb unreachable rather than merely fixed.
const argv = process.argv.slice(2);
const parsed = parseArgs(argv);

if (!parsed.ok) {
  console.error('');
  for (const e of parsed.errors) console.error(`  ${e}`);
  if (parsed.hint === 'unknown') {
    console.error('\n  If that was part of your question, QUOTE the question. The shell splits it into');
    console.error('  arguments, and a flag-shaped word would be stripped from the question AND switched');
    console.error('  on — a different question, in a different mode, reported as success.');
    console.error('\n      node scripts/council.mjs "Should we use --lenses here?" --context src/x.js');
    console.error('\n  Or put the question after `--`, and nothing in it is read as a flag:');
    console.error('\n      node scripts/council.mjs -- Should we use --lenses here?');
  }
  if (parsed.hint === 'space-form') {
    console.error('\n  Given with a space, the value would be swallowed into the question instead.');
  }
  console.error(`\n  Options: ${Object.keys(FLAGS).map((f) => `--${f}`).join(' ')}\n`);
  process.exit(1);
}

const has = (n) => Boolean(parsed.flags[n]);
/** The string value of a `=`-style flag, or undefined for a bare switch. */
const flag = (n) => (typeof parsed.flags[n] === 'string' ? parsed.flags[n] : undefined);
const ctxFiles = parsed.list.context ?? [];
let { questionTokens, question } = parsed;

// ── --question-file: the question never goes through a shell ──────────────────
//
// **Every way of putting prose into a shell argument is unsafe for some prose**, and the council found
// that the hard way after this file's own advice made it worse. Measured:
//
//   'Should we cache the user's session?'    → the shell dies on the apostrophe, and English prose is
//                                             full of apostrophes
//   -- Is $HOME safe and does `id -un` matter? → $HOME expanded and `id -un` EXECUTED
//
// The second was recommended here as the SAFE form. It turns the user's own words into executed shell.
//
// There is no quoting rule that fixes this, so the fix is not a quoting rule: the question goes in a
// file and the shell never sees it. Both judges reached that independently, and they were right.
if (flag('question-file')) {
  const qf = path.resolve(ROOT, flag('question-file'));
  try {
    const st = fs.statSync(qf);
    // The FIFO lesson again: a non-regular file blocks the read forever, before any timeout exists.
    if (!st.isFile()) throw new Error('not a regular file (a FIFO or device would block forever)');
    if (st.size > 1024 * 1024) throw new Error(`${(st.size / 1024).toFixed(0)} KB — a question, not a corpus`);
    question = fs.readFileSync(qf, 'utf8').trim();
    questionTokens = [question];
  } catch (e) {
    console.error(`\n  --question-file=${flag('question-file')} could not be read: ${e.message}\n`);
    process.exit(1);
  }
  if (!question) {
    console.error(`\n  --question-file=${flag('question-file')} is empty.\n`);
    process.exit(1);
  }
  if (parsed.questionTokens.length) {
    console.error(`\n  Both --question-file and a question on the command line were given. Pick one —`);
    console.error(`  silently preferring either would answer a question you did not ask.\n`);
    process.exit(1);
  }
}

// Per-member, in minutes. Clamped by the parser to [1, 120]: `Number(flag) > 0` used to accept 0.0001
// — a 6-millisecond budget that killed every member before it could speak — and an absurd upper value
// turns the never-hang guarantee off.
const timeoutMin = parsed.flags.timeout ?? 15;
if (parsed.flags.timeoutClamped) {
  const c = parsed.flags.timeoutClamped;
  console.error(`  --timeout=${c.from} clamped to ${c.to} minute(s) — the range is ${c.min} to ${c.max}.`);
}

// A quoted question is ONE argument. Several bare words mean the shell split it — and if a flag is
// present as well, the odds are that flag was part of the sentence:
//
//     node council.mjs Should we use --lenses here?   ->  question "Should we use here?", --lenses ON
//
// which is a different question in a different mode, reported as a success. The unknown-flag refusal
// cannot catch this one, because `--lenses` is a real flag. Token count can, exactly.
const anyFlag = argv.some((a) => a.startsWith('--'));
if (questionTokens.length > 1 && anyFlag && !argv.includes('--') && !flag('question-file')) {
  console.error(`\n  The question arrived as ${questionTokens.length} separate words, so it was not quoted:`);
  console.error(`      ${questionTokens.map((t) => JSON.stringify(t)).join(' ')}`);
  console.error('\n  QUOTE it. Unquoted, the shell splits the sentence into arguments — and any');
  console.error('  flag-shaped word in it is stripped from the question AND switched on, so the council');
  console.error('  answers a different question in a different mode and reports success.');
  console.error('\n      node scripts/council.mjs "the whole question here" --context src/x.js');
  console.error('\n  Or pass it after `--`:  node scripts/council.mjs -- the whole question here\n');
  process.exit(1);
}

// `--context` consumes every following word, so an unquoted question placed after it is swallowed as
// a list of file paths and the run dies on "no question" with no hint why. A context entry that is
// not a readable file is almost always exactly that mistake.
const notFiles = ctxFiles.filter((f) => {
  try { return !fs.statSync(path.resolve(ROOT, f)).isFile(); } catch { return true; }
});
if (notFiles.length) {
  console.error(`\n  --context was given ${notFiles.length} value(s) that are not readable files:`);
  for (const f of notFiles.slice(0, 8)) console.error(`      ${f}`);
  console.error('\n  --context consumes every following word, so an UNQUOTED question after it is');
  console.error('  swallowed as file paths. Quote the question, and put it first:');
  console.error('\n      node scripts/council.mjs "the question" --context src/a.js src/b.js\n');
  process.exit(1);
}

const stage1Only = has('stage1-only');
const useLenses = has('lenses');
const rubricMode = has('rubric');
const only = flag('members')?.split(',');
// Per-member, in minutes. A council of five is bounded by its slowest member, and 15 minutes was
// chosen for a model that thinks; a smaller budget is a legitimate choice on a smaller question.

if (!question && !has('verify-delivery')) {
  console.error('Usage: council.mjs "<question>" [--context <file>...] [--events] [--lenses] [--rubric]');
  console.error('       council.mjs --verify-delivery       # prove each member actually receives its prompt');
  process.exit(1);
}

// A roster missing `scratchDir` used to crash here with `Cannot read properties of undefined`,
// before any handler was installed — a raw node stack trace instead of the named, actionable refusal
// every other bad-roster case gets. It defaults instead, because a scratch directory is an
// implementation detail rather than a decision a roster has to make.
// A LEADING tilde only. `.replace('~', ...)` hit the first tilde anywhere, so a legitimate path
// containing one — `/tmp/build~1/scratch` — was rewritten into nonsense at the wrong offset.
const scratch = String(CFG.scratchDir ?? '~/.nexa-council-scratch').replace(/^~(?=\/|$)/, os.homedir());
if (!path.isAbsolute(scratch)) {
  console.error(`\n  The roster's scratchDir must be absolute (or start with ~). Got: ${CFG.scratchDir}\n`);
  process.exit(2);
}
try {
  // mkdirpSafe, never recursive mkdirSync: `scratchDir` comes from the ROSTER, so a mistaken or
  // hostile value like "/proc/x/y" would hang the council here — before pre-flight, before a single
  // member starts. See safe-write.mjs for the measurement.
  mkdirpSafe(scratch);
} catch (e) {
  console.error(`\n  Could not create the scratch directory ${scratch}: ${e.message}\n`);
  process.exit(2);
}

// ── the run's filename, and why a long question gets a hash on the end ────────
//
// The slug was the question, sanitised and cut to 60 characters. Two different questions that agree
// for their first 60 characters therefore produced the **same** filename — and this was not
// hypothetical: the two rounds of grading this package differed only in a paragraph appended to the
// end, so the second round silently overwrote the first round's `.md`, and appended its events to the
// first round's stream. One stream file ended up containing two `run_start` events, which no consumer
// is built to expect.
//
// A 6-character hash of the FULL question is appended whenever the slug had to be cut. Short
// questions keep clean, predictable filenames; long ones become distinct. Not applied
// unconditionally, because a readable filename in `.council/runs/` is most of what makes the
// directory browsable.
const SLUG_MAX = 60;
const bare = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const qhash = crypto.createHash('sha256').update(question).digest('hex').slice(0, 6);
let slug = (bare.length > SLUG_MAX ? `${bare.slice(0, SLUG_MAX).replace(/-$/, '')}-${qhash}` : bare)
  || 'council';

// A SHORT question can still collide: "Is it safe?" and "Is it safe!" normalise to the same slug, and
// the second run silently overwrote the first one's record. Only the long case was hashed, on the
// assumption that truncation was the only way to lose information — normalisation loses it too.
//
// Checked rather than hashed unconditionally, so a readable filename stays the common case: the hash
// is appended only when a DIFFERENT question already owns that name. A re-run of the SAME question
// still overwrites, which is what a re-run should do.
try {
  const prior = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${slug}.json`), 'utf8'));
  if (prior.question && prior.question !== question) slug = `${slug}-${qhash}`;
} catch { /* no prior run under this name, or unreadable — either way keep the clean slug */ }

// ── --detach: the run must outlive the session that started it ────────────────
//
// **The problem this solves is not cosmetic.** A council is 10–30 minutes. An agent that starts one
// and then blocks is unusable — it cannot do anything else, and if its session is killed, restarted,
// or times out during those minutes, the whole run is lost. Not "lost and resumable": the members
// were already paid for, and there is nothing to show.
//
// `--detach` re-executes this script in its own session (`setsid`-equivalent via `detached: true`),
// with stdio pointed at files rather than inherited pipes, then prints the paths and exits 0
// immediately. The council keeps running with no terminal attached and no parent.
//
// Three properties make it actually safe rather than just backgrounded:
//
//   1. **`detached: true` + `unref()`** — a new process group with no parent link, so the child is
//      not in the harness's group and does not receive its SIGTERM or SIGHUP.
//   2. **stdio to FILES, never pipes.** An inherited pipe whose reader goes away turns the next
//      write into EPIPE and kills the child. This is the failure that makes naive `&` unreliable.
//   3. **The event stream is forced on.** Detaching without it would be launching a process nobody
//      can observe, which is worse than blocking.
//
// What the caller gets back is enough to attach later from ANY session: the events path, the log
// path, and the pid. `scripts/status.mjs` turns those into an answer.
if (has('detach')) {
  // `without()`, not a filter on the bare token. Filtering `a !== '--detach'` left `--detach=1` in
  // the child's argv, so the child re-detached and so did its child: an unbounded respawn chain in
  // which the council never ran. Three of four judges found it independently.
  const child = without(argv, ['detach']);
  if (!child.some((a) => a === '--events' || a.startsWith('--events='))) child.push('--events');
  // No live block in a process with no terminal.
  if (!child.includes('--no-live')) child.push('--no-live');

  const logPath = path.join(OUT_DIR, `${slug}.log`);
  const w = checkWritable(logPath, ROOT);
  if (!w.ok) {
    console.error(`\n  Cannot detach: ${w.reason}\n`);
    process.exit(1);
  }
  // Through the same boundary as every other output. This was a plain `openSync(logPath, 'w')` —
  // the newest code in the file, not held to the standard the rest of it enforces, which is exactly
  // what a judge said about it.
  mkdirpSafe(path.dirname(logPath));
  const logFd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
    | (fs.constants.O_NOFOLLOW ?? 0), 0o644);

  const kid = spawn(process.execPath, [fileURLToPath(import.meta.url), ...child], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, COUNCIL_DETACHED: '1' },
  });
  kid.unref();
  fs.closeSync(logFd);

  // **Confirm the child actually came up before claiming it did.** `spawn` succeeding means the fork
  // happened, not that the process survived its own synchronous startup — a bad roster, an unwritable
  // events path or a missing member all exit within milliseconds. Reporting "the council is running"
  // and exiting 0 in that case leaves a watcher waiting forever on a stream that will never grow.
  //
  // 400ms is enough for every startup refusal observed (they are all synchronous and immediate) and
  // short enough not to be a wait. If it is still alive after that, it got past pre-flight.
  // **The EXIT CODE, not merely liveness.** A first attempt at this asked "is the pid still there
  // after 400ms", which cannot tell a startup failure from a run that legitimately finished fast —
  // `--detach --preflight` exits 0 in milliseconds and would have been reported as "NOT started".
  //
  // Racing the exit against a short timer answers both questions: still alive means it got past its
  // synchronous startup; exited 0 means it did the whole job; exited non-zero means it refused, and
  // the reason is in the log the child was already writing to.
  const outcome = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ alive: true }), 400);
    kid.once('exit', (code) => { clearTimeout(t); resolve({ alive: false, code: code ?? 0 }); });
  });

  // Exit 2 is this script's own code for "could not convene" — no member CLI installed. That is a
  // legitimate answer, not a crash, and calling it "NOT started" would be wrong on any machine
  // without the CLIs, which includes every CI runner. Only an unexpected non-zero code is a failure.
  if (!outcome.alive && outcome.code !== 0 && outcome.code !== 2) {
    let why = '';
    try { why = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-8).join('\n'); } catch { /* nothing written */ }
    console.error(`\n  The detached council exited immediately with code ${outcome.code}. It was NOT started.\n`);
    if (why) console.error(`${why}\n`);
    console.error(`  Full output: ${path.relative(ROOT, logPath)}\n`);
    process.exit(1);
  }
  const finishedFast = !outcome.alive;
  const couldNotConvene = !outcome.alive && outcome.code === 2;

  const evPath = flag('events') || path.join(OUT_DIR, `${slug}.events.ndjson`);
  process.stderr.write(couldNotConvene
    ? `\n▸ Detached, but it could not convene — no member CLI is available here. Nothing was spent.\n\n`
    : finishedFast
      ? `\n▸ Detached, and it already finished — the work was short enough not to need this.\n\n`
      : `\n▸ Detached. The council is running with no parent — this session can die without losing it.\n\n`);
  process.stderr.write(`    pid     ${kid.pid}\n`);
  process.stderr.write(`    events  ${path.relative(ROOT, evPath)}\n`);
  process.stderr.write(`    log     ${path.relative(ROOT, logPath)}\n\n`);
  process.stderr.write(`  Watch it:   node ${path.relative(ROOT, path.join(HERE, 'watch.mjs'))} ${path.relative(ROOT, evPath)}\n`);
  process.stderr.write(`  Ask once:   node ${path.relative(ROOT, path.join(HERE, 'status.mjs'))}\n`);
  process.stderr.write(`  Live feed:  node ${path.relative(ROOT, path.join(HERE, 'feed.mjs'))}\n\n`);
  // stdout stays machine-readable: one JSON object, so a caller does not have to parse prose.
  console.log(JSON.stringify({ detached: true, running: !finishedFast, convened: !couldNotConvene,
    pid: kid.pid, events: evPath, log: logPath, slug }));
  process.exit(0);
}

// ── the event stream, and the live view fed from it ──────────────────────────
//
// One source of truth. Every progress signal a human sees is derived from the same events a UI
// would consume, so the terminal cannot be right while the stream is wrong — the failure this
// arrangement is designed to make impossible.
const eventsPath = has('events')
  ? (flag('events') || path.join(OUT_DIR, `${slug}.events.ndjson`))
  : null;
// **Checked BEFORE the emitter opens.** The earlier symlink guard sat next to the markdown write, so
// the event stream — opened at startup and written to for the entire run — was the one output nothing
// checked, and the guard's own class of bug was reintroduced by the fix for it. Three of four judges
// found this independently, which is what moved the check into `safe-write.mjs` and put every write
// through it instead of adding a third patch.
if (eventsPath) {
  // An EXPLICIT `--events=/tmp/run.ndjson` is operator intent, and refusing it because /tmp is not
  // inside the workspace was both wrong and wrongly explained — the message said a symlink had
  // redirected the file. Containment exists to stop a REPO choosing a destination; a person naming one
  // on the command line is the opposite case. The symlink refusal still applies either way, because
  // that one protects the operator from something they did not choose.
  const explicit = Boolean(flag('events'));
  const boundary = explicit ? path.parse(path.resolve(eventsPath)).root : ROOT;
  const w = checkWritable(eventsPath, boundary);
  if (!w.ok) {
    console.error(`\n  Refusing to open the event stream: ${w.reason}\n`);
    process.exit(1);
  }
}

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

// Both sinks, not just the file one. events.mjs was taught to detect an unopenable fd 3 and this
// guard still only asked about `eventsPath` — so the comment there claiming the asymmetry was fixed
// was itself the remaining half of the bug.
if ((eventsPath || has('json-events')) && emitter.broken) {
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
// **Windows is not supported, and saying so is the fix.**
//
// This function splits PATH on ':', which mangles `C:\\...`; it ignores PATHEXT, so `codex.cmd`
// is invisible; and the teardown in ask() uses `process.kill(-pid)`, which win32 has no equivalent
// for. `ARGV_CEILING.win32` exists in prompt-delivery.mjs as documentation of the platform's real
// limit, not as a claim that the runtime works there — a claim this refuses loudly rather than
// discovering as "every member is missing".
if (process.platform === 'win32') {
  console.error('\n  Windows is not supported. Executable lookup here is POSIX-only (PATH split on'
    + '\n  ":", no PATHEXT) and the never-hang teardown needs POSIX process groups.'
    + '\n\n  Use WSL, where everything in this package works normally.\n');
  process.exit(2);
}

/**
 * Resolve a member's command to the ABSOLUTE path that will actually be spawned.
 *
 * Returns the resolved path, or null if there is nothing runnable.
 *
 * The old version answered a different question from the one that mattered. It reported whether SOME
 * executable of that name existed, searching `~/.local/bin`, `~/.npm-global/bin`, `/usr/local/bin`
 * and `/opt/homebrew/bin` **before** PATH — then handed the bare name to `spawn`, which searches
 * PATH and nothing else, in PATH order. So pre-flight could confirm `/opt/homebrew/bin/codex` while
 * the run executed a different `codex` from earlier in PATH, or confirm one that `spawn` could not
 * find at all. Pre-flight exists to remove exactly this kind of surprise.
 *
 * Now it resolves once and the resolved absolute path is what gets spawned, so the thing checked and
 * the thing run are the same file by construction. PATH is searched first, in order, because that is
 * what an ordinary shell would do; the extra directories are a fallback for CLIs installed outside a
 * login shell's PATH, and **using one is reported at pre-flight** — the doc comment claimed that
 * before any code did it, which is its own small dishonesty.
 */
function resolveCmd(cmd) {
  const runnable = (f) => {
    // Existence is not enough: a non-executable file at the right path is reported as present and
    // then fails at spawn time, which is exactly the mid-run discovery pre-flight exists to avoid.
    try { fs.accessSync(f, fs.constants.X_OK); return !fs.statSync(f).isDirectory(); } catch { return false; }
  };
  if (cmd.includes('/')) return runnable(cmd) ? path.resolve(cmd) : null;
  // Relative PATH entries are legal and `spawn` resolves them against ITS cwd — which is the scratch
  // directory, not ours. So pre-flight could find `./bin/codex` relative to the repo and the run could
  // fail to find it at all, which is the pre-flight/spawn divergence this function exists to remove,
  // surviving in the one case nobody writes down. Skipped rather than guessed at: a relative PATH entry
  // is rare, and reporting the member as absent is honest.
  const onPathDirs = (process.env.PATH ?? '').split(':').filter((d) => d && path.isAbsolute(d));
  const extra = [`${os.homedir()}/.local/bin`, `${os.homedir()}/.npm-global/bin`,
    '/usr/local/bin', '/opt/homebrew/bin'];
  for (const d of onPathDirs) {
    const f = path.join(d, cmd);
    if (runnable(f)) return f;
  }
  for (const d of extra) {
    const f = path.join(d, cmd);
    // Found outside PATH. Reported, because it means `cmd` alone would not have worked in a shell —
    // useful to know before blaming the council for a CLI the user thinks is installed.
    if (runnable(f)) return { path: f, offPath: d };
  }
  return null;
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
// A typo in --members used to fall through to "no council member is available — install one", about
// CLIs the user has installed. The roster knows its own ids; say so.
if (only) {
  const known = new Set(CFG.members.map((m) => m.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length) {
    console.error(`\n  --members named ${unknown.length} id(s) that are not in the roster: ${unknown.join(', ')}`);
    console.error(`  Available: ${[...known].join(', ')}\n`);
    process.exit(1);
  }
}
const asked = CFG.members.filter((m) => !only || only.includes(m.id));
// Anything not positively verified, not only an explicit `false`.
const uncontained = asked.filter((m) => m.contained !== true);
// **Fails CLOSED on an undefined `contained`.** `m.contained !== false` treated a member with no
// such field as contained, so any roster that simply omitted it — a hand-written one, an older
// packaged one, a future member added without running the verifier — was silently trusted. The
// verifier writes the field; its absence means nobody has checked, which is not the same as safe.
const requested = (allowUncontained ? asked : asked.filter((m) => m.contained === true))
  // Resolved once. `resolved` is what ask() spawns, so pre-flight and the run cannot disagree.
  .map((m) => {
    const r = resolveCmd(m.cmd);
    return typeof r === 'object' && r ? { ...m, resolved: r.path, offPath: r.offPath } : { ...m, resolved: r };
  });
const members = requested.filter((m) => m.resolved);
const absent = requested.filter((m) => !m.resolved);

ev('run_start', {
  schema: SCHEMA,
  question,
  // The PID is in the stream so a consumer can tell "still thinking" from "died without finishing".
  // Without it, a stream that stops mid-run is indistinguishable from one that is merely quiet — and
  // "quiet" is the normal state of this tool for minutes at a time.
  pid: process.pid,
  // The CHILD is the detached one, and it no longer carries --detach — so asking `has('detach')`
  // here always answered false in the very stream that is supposed to be the source of truth.
  // COUNCIL_DETACHED is set on the child's environment instead.
  detached: process.env.COUNCIL_DETACHED === '1',
  members: requested.map((m) => ({ id: m.id, label: m.label, family: m.family ?? 'unknown' })),
  flags: { lenses: useLenses, rubric: rubricMode, revise: has('revise'), stage1Only, timeoutMin, allowUncontained },
  excludedUncontained: allowUncontained ? [] : uncontained.map((m) => m.id),
});
ev('preflight', {
  available: members.map((m) => m.id),
  absent: absent.map((m) => ({ id: m.id, label: m.label, cmd: m.cmd })),
});

if (localRosterIgnored) {
  log(`\n▸ Ignored \`.council/members.json\` — a repo cannot choose what gets executed.`);
  log(`    Every field in a roster is a command this script will run, including the \`contained\``);
  log(`    flag that decides whether a member is allowed to write files. Pass --local-roster to use`);
  log(`    it; its members are then treated as UNCONTAINED whatever the file says, so`);
  log(`    --allow-uncontained is required too.`);
}
if (usingLocal) {
  log(`\n▸ ⚠ Using the repo-local roster at \`.council/members.json\` (--local-roster).`);
  log(`    \`contained\` was stripped from it: containment is something verify-containment.mjs`);
  log(`    demonstrates, not something a file in the working directory may claim.`);
}

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
  // Two different reasons, and they need different advice. When every member was filtered out for
  // being uncontained, `requested` is EMPTY — so this printed "Requested: " with nothing after it and
  // told the user to install a CLI they already have.
  if (!requested.length && uncontained.length) {
    log(`\n  No council member is available: all ${uncontained.length} requested member(s) were excluded`);
    log(`  because they cannot be prevented from writing files.`);
    for (const m of uncontained) log(`    🚨 ${m.label}`);
    log(`\n  Either run \`node scripts/verify-containment.mjs\` to re-check them, or pass`);
    log(`  --allow-uncontained if you accept the risk. Nothing was spent and nothing was written.\n`);
  } else {
    log(`\n  No council member is available on this machine.`);
    log(`  Requested: ${requested.map((m) => m.cmd).join(', ') || '(none left after filtering)'}`);
    log(`\n  Install one, or run with --members=<id> for those you do have.`);
    log(`  Nothing was spent and nothing was written.\n`);
  }
  ev('run_done', { ok: false, answered: 0, requested: requested.length, file: null, exitCode: 2 });
  emitter.close(); render.finish();
  process.exit(2);   // 2 = could not convene, distinct from 1 = convened and all failed
}

if (has('preflight')) {
  log(`\n  ${members.length}/${requested.length} member(s) available: ${members.map((m) => m.label).join(', ')}`);
  log(`  Prompt delivery: ${members.map((m) => `${m.id}=${deliveryOf(m)}`).join(', ')}`);
  // The resolved path, printed. `contained: true` in the roster was measured against whatever `codex`
  // resolved to on the day the verifier ran; if PATH has changed since, the attestation is about a
  // different file. This does not re-measure — that is verify-containment.mjs's job — but it makes the
  // gap visible instead of implicit, so the two can be compared by eye.
  log(`  Resolved to:`);
  for (const m of members) log(`    ${m.id.padEnd(14)} ${m.resolved}`);
  for (const m of members.filter((x) => x.offPath)) {
    log(`  ⚠ ${m.label} was found in ${m.offPath}, which is NOT on your PATH — \`${m.cmd}\` alone`);
    log(`    would not work in a shell. The council uses the resolved path, so it runs either way.`);
  }
  log('  Pre-flight only — nothing was run.\n');
  ev('run_done', { ok: true, answered: 0, requested: requested.length, file: null, exitCode: 0 });
  emitter.close(); render.finish();
  process.exit(0);
}

// The seeded shuffle lives in diagnostics.mjs — it was inline and therefore unmeasurable, which
// is how a generator reaching only 23 of 120 orderings survived. See the comment there.
// ── the heartbeat ────────────────────────────────────────────────────────────
//
// One timer for the whole run rather than one per member: five timers producing five interleaved
// streams of ticks is the same information at five times the volume, and a UI then has to
// reassemble what the parent already knew.
//
// Unref'd, so it can never be the reason node stays alive — the bug this file has a whole section
// about, reintroduced by the progress indicator, would be a poor trade.
// ── the environment a member is given ─────────────────────────────────────────
//
// `spawn` inherits `process.env` by default, and this package's whole argument is that we control
// what leaves the machine. A developer shell routinely holds `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`,
// `GITHUB_TOKEN`, database URLs — none of which any member needs, and all of which were handed to four
// vendors' CLIs on every call. "Context is assembled, never granted" was true of the prompt and not
// of the process.
//
// An allowlist rather than a denylist, for the same reason context.mjs uses containment rather than
// patterns: the set of secret-shaped variable names cannot be enumerated, and the set a CLI genuinely
// needs is short. HOME and PATH because the CLIs read their own config and shell out; the rest is
// terminal and locale so output is not mangled.
//
// **This deliberately does NOT strip the CLIs' own auth.** They authenticate from files under HOME —
// that is the entire premise of "no API keys" — so HOME has to stay, and a member can still read
// `~/.aws/credentials` if it chooses to. That limit is in the README; this closes the part that was
// gratuitous.
// NODE_OPTIONS is deliberately NOT here. It was, and it undoes the point: `NODE_OPTIONS=--require`
// runs arbitrary code inside a member's process before its own permission mode is established, so the
// one variable that looked harmless was the one that could disable containment from the outside.
// The proxy variables are here because a member with no network is a member that fails, and on a
// corporate machine that is EVERY member — with an opaque connection error rather than anything
// pointing at the allowlist. They carry no credentials themselves (a proxy URL with an embedded
// password would be caught by the secret-shape scan if it ever reached a prompt, and it never does).
const ENV_ALLOW = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
  'TERM', 'TZ', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'ALL_PROXY', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
const memberEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => ENV_ALLOW.includes(k)),
);
const envDropped = Object.keys(process.env).length - Object.keys(memberEnv).length;

const live = new Map();          // id → {member, stage, started, bytes, lastLine}

// ── nothing outlives this process ─────────────────────────────────────────────
//
// Members are spawned `detached`, in their own process groups, so the timeout can kill a whole tree.
// The cost of that is a Ctrl-C: the parent dies and the groups do not, leaving four model CLIs
// running invisibly, still spending, with no terminal attached. `unref` prevents them holding node
// open; it does nothing to stop them existing.
//
// So the interrupt is caught, every live group is killed, and the stream is terminated properly.
// Every prompt file currently on disk. A `file`-delivery member's prompt IS the whole context pack,
// 0600 in the scratch dir. ask() removes its own the moment the member exits; this set covers the
// path where the process dies before that happens, which is precisely when it matters.
const promptFiles = new Set();
const cleanupPromptFiles = () => {
  for (const f of promptFiles) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  promptFiles.clear();
};

const killAllLive = (sig) => {
  for (const [, s] of live) {
    if (!s.pid) continue;
    try { process.kill(-s.pid, sig); } catch { /* group already gone */ }
  }
};

let shuttingDown = false;
const shutdown = (why, code) => {
  if (shuttingDown) return;
  shuttingDown = true;
  killAllLive('SIGTERM');
  // The stream promises a terminal event. Without this a UI tailing the file waits forever on a run
  // that ended, which is indistinguishable from the hang this whole design exists to rule out.
  try { ev('run_error', { message: why }); } catch { /* the stream is already gone */ }
  try { clearInterval(ticker); emitter.close(); render.finish(); } catch { /* nothing to close */ }
  // **Set FIRST, and the backstop timer is deliberately NOT unref'd.**
  //
  // Measured: an `unref`'d timer does not hold the event loop open, so with nothing else pending node
  // exited normally — code **0** — before the SIGKILL sweep and the `process.exit(code)` inside it
  // ever ran. A council that died of an uncaught error reported success to whatever wrapped it, which
  // is the single thing a caller relies on. Probed with a script that scheduled an unref'd `exit(7)`
  // and observed the process exit 0.
  process.exitCode = code;
  setTimeout(() => { killAllLive('SIGKILL'); cleanupPromptFiles(); process.exit(code); }, 300);
};

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    process.stderr.write(`\n  ${sig} — stopping ${live.size} running member(s) so nothing keeps spending.\n`);
    shutdown(`interrupted by ${sig}`, 130);
  });
}
// An uncaught throw used to end the run with a node stack trace and NO terminal event at all.
process.on('uncaughtException', (e) => shutdown(`uncaught: ${e?.message ?? e}`, 1));
process.on('unhandledRejection', (e) => shutdown(`unhandled rejection: ${e?.message ?? e}`, 1));
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
/** Far past any real answer; reaching it means a member is malfunctioning, not being thorough. */
const MAX_MEMBER_OUTPUT = 8 * 1024 * 1024;

function ask(member, prompt, { stage = '1', raw = false } = {}) {
  const started = Date.now();
  const timeoutMs = timeoutMin * 60_000;
  const done = (ok, text, extra = {}) => {
    const r = { id: member.id, label: member.label, ok, text: String(text).trim(), ms: Date.now() - started, ...extra };
    // Redacted. events.mjs promises that `lastLine` is the ONLY field echoing child output, and
    // this field was quietly breaking that: a failure reason is raw stdout/stderr, which can contain
    // a fragment of the pack or a credential the CLI printed in a diagnostic.
    ev('member_done', { stage, id: member.id, label: member.label, ok: r.ok, ms: r.ms,
      chars: r.text.length, reason: ok ? undefined : redactLine(r.text.split('\n')[0], 160) });
    return r;
  };

  // `{timeoutMin}` goes in through `subs`, so it is applied to the ARGS TEMPLATE and can never
  // touch the prompt. Substituting it afterwards rewrote pack content for the argv member.
  const plan = prepare(member, prompt, scratch, process.platform,
    { timeoutMin: Math.max(1, timeoutMin - 1) });
  // Returned explicitly by prepare(), not recovered by matching an argument prefix. The prefix scan
  // would also match any ARGUMENT that happened to start with the scratch path — and, more to the
  // point, it silently found nothing if the path substitution ever changed shape, leaving the file
  // that holds the entire context pack untracked for the interrupt path.
  const promptFile = plan.ok ? (plan.promptFile ?? null) : null;
  if (promptFile) promptFiles.add(promptFile);
  ev('member_start', { stage, id: member.id, label: member.label, promptChars: prompt.length, via: plan.via });

  // A member that cannot be handed this prompt is reported like any other failure. Named, with the
  // reason and the remedy, before a single token is spent.
  if (!plan.ok) return Promise.resolve(done(false, plan.reason));

  return new Promise((resolve) => {
    let out = '', err = '', settled = false, truncatedOutput = false;
    const state = { member, stage, started, bytes: 0, lastLine: '', pid: null };
    live.set(member.id, state);

    const finish = (ok, text) => {
      if (settled) return;
      settled = true;
      live.delete(member.id);
      plan.cleanup();
      if (promptFile) promptFiles.delete(promptFile);
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
      // The path resolved at pre-flight, never the bare name — otherwise this could execute a
      // different binary from the one that was checked.
      p = spawn(member.resolved ?? member.cmd, plan.args, {
        cwd: scratch,
        env: memberEnv,
        stdio: [plan.stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      finish(false, `could not start ${member.cmd}: ${e.message}`);
      return;
    }

    state.pid = p.pid;   // so an interrupt can kill this member's whole group

    // **Decode as UTF-8 across chunk boundaries, not per chunk.**
    //
    // `out += d` on a Buffer calls `toString()` on THAT CHUNK, so a multi-byte character split across
    // a pipe-buffer boundary is decoded as two invalid halves and becomes U+FFFD. Pipe buffers are
    // ~64 KiB, so it hits every answer longer than that — and this project's own prose is dense with
    // em-dashes and arrows, which are exactly the 3-byte characters that straddle.
    //
    // Measured: 100,000 em-dashes through a pipe arrived with **8 replacement characters** and did not
    // match the input. With `setEncoding('utf8')` the stream buffers the partial sequence and hands
    // over complete characters: zero corruption, exact match.
    //
    // Silent corruption of every answer, review and record the tool produces — the failure class this
    // project ranks above all others — closed by one line.
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');

    if (plan.stdin !== null) {
      // EPIPE here means the child exited before reading the prompt — a result, not a crash. The
      // close handler will report whatever it managed to say.
      p.stdin.on('error', () => {});
      p.stdin.end(plan.stdin);
    }

    // Bounded, and scanned incrementally.
    //
    // Two problems in one line. `out` grew without limit — a member stuck in a loop could exhaust
    // memory long before the timeout noticed — and `out.split('\n')` re-scanned the WHOLE accumulated
    // buffer on every chunk, which is quadratic in the size of an answer. On a member producing
    // megabytes that is a pegged core and a heartbeat arriving late, which is exactly when the
    // heartbeat matters most.
    //
    // The cap is generous: 8 MiB is ~2M tokens, orders of magnitude past any real answer, so reaching
    // it means a member is malfunctioning rather than being thorough. Truncation is ANNOUNCED inside
    // the text, for the same reason context.mjs announces it — half an answer, silently, is reasoned
    // about as confidently as a whole one.
    p.stdout.on('data', (d) => {
      if (!truncatedOutput) {
        // BYTES, matching the name and the message. `out.length` is UTF-16 code units, so the real
        // ceiling was up to 3x the announced MiB for multi-byte output — in the permissive direction.
        if (Buffer.byteLength(out, 'utf8') + Buffer.byteLength(String(d), 'utf8') > MAX_MEMBER_OUTPUT) {
          out += String(d).slice(0, Math.max(0, MAX_MEMBER_OUTPUT - Buffer.byteLength(out, 'utf8')))
            + `\n\n[TRUNCATED — this member produced more than ${MAX_MEMBER_OUTPUT / 1024 / 1024} MiB, `
            + `far past any real answer. Treat what is above as incomplete.]`;
          truncatedOutput = true;
        } else {
          out += d;
        }
      }
      // BYTES, as the field name says. `String.length` is UTF-16 code units, so a member writing
      // em-dashes reported a third of its real output volume to every UI reading the stream.
      state.bytes = Buffer.byteLength(out, 'utf8');
      // Only the newly arrived chunk is scanned, not the whole buffer.
      const fresh = String(d).split('\n').filter((l) => l.trim());
      if (fresh.length) state.lastLine = redactLine(fresh[fresh.length - 1]);
    });
    // Capped too. stderr is where a CLI puts progress spinners, and an unbounded one is the same
    // memory problem with a less interesting cause.
    p.stderr.on('data', (d) => { if (err.length < 256 * 1024) err += d; });
    p.stdout.on('error', () => {});          // EPIPE if the child dies mid-write
    p.stderr.on('error', () => {});
    p.on('error', (e) => finish(false, `could not start ${member.cmd}: ${e.message}`));
    // `raw` skips the answer heuristics. A canary probe is not an answer — it is 20 characters
    // that either contain a token or do not — and running it through MIN_ANSWER_CHARS is how
    // --verify-delivery came to fail every member that complied exactly.
    p.on('close', (c) => finish(...(raw
      ? [c === 0 || out.trim().length > 0, out.trim() || (err || '').trim() || `exit ${c}`]
      : judgeOutput(out, err, c))));

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
    const r = await ask(m, c.prompt, { stage: 'verify', raw: true });
    // Three outcomes, not two. A member that REFUSED the probe plainly received it, and reporting
    // that as "the prompt is not arriving" sends someone to edit a promptVia that was correct.
    const arrived = r.ok && c.arrived(r.text);
    const refused = !arrived && r.ok && c.refused(r.text);
    return { m, ok: arrived, refused, r, via: deliveryOf(m) };
  }));
  log('');
  for (const { m, ok, refused, r, via } of results) {
    const verdict = ok ? 'canary returned'
      : refused ? `declined the probe (so it DID receive it) — "${redactLine(r.text, 50)}"`
      : `NO CANARY — "${redactLine(r.text, 60)}"`;
    log(`  ${ok ? '✅' : refused ? '➖' : '❌'} ${m.label.padEnd(30)} via ${via.padEnd(6)} ${verdict}`);
  }
  const bad = results.filter((x) => !x.ok && !x.refused);
  const declined = results.filter((x) => x.refused);
  if (declined.length) {
    log(`\n  ${declined.length} member(s) declined the probe rather than failing it. Their delivery channel`);
    log(`  is FINE — the token would not have come back at all otherwise. Nothing to fix in the roster.`);
  }
  if (bad.length) {
    log(`\n  ${bad.length} member(s) did not return the canary and did not decline it. Their prompt is`);
    log(`  not arriving — fix promptVia in the roster before trusting anything they say.\n`);
  } else {
    log(`\n  All ${results.length} receive their prompt.\n`);
  }
  ev('run_done', { ok: !bad.length, answered: results.length - bad.length, requested: results.length,
    file: null, exitCode: bad.length ? 1 : 0, declined: declined.map((x) => x.m.id) });
  emitter.close(); render.finish();
  process.exit(bad.length ? 1 : 0);
}

for (const m of members.filter((x) => x.offPath)) {
  log(`\n▸ ${m.label} was found in ${m.offPath}, which is not on your PATH.`);
  log(`    The council spawns the resolved absolute path, so this is informational — but \`${m.cmd}\``);
  log(`    alone would not work in a shell, which is worth knowing before blaming the council.`);
}

if (members.length < requested.length) {
  log(`\n  Continuing with ${members.length} of ${requested.length}. A smaller council is a`);
  log('  weaker one — fewer independent readers, and the tally means less.');
}

// ── context ──────────────────────────────────────────────────────────────────
const ctx = buildContext(ctxFiles, ROOT);
const brief = loadBrief(ROOT);
// The BRIEF counts too. This was `ctx.chars / 4`, which undercounted what every member actually
// receives by the whole size of the brief — up to 8,000 characters, or 2k tokens, of the thing the
// warning exists to measure.
const ctxTok = Math.round((ctx.chars + (brief.text?.length ?? 0)) / 4);

// The budget is shown every run, because the failure at the ceiling is silent: at ~80k one member
// stopped following instructions rather than erroring. Measured 2026-07-28.
log(`\n▸ Context — ${ctx.files.length} file(s), ~${(ctxTok / 1000).toFixed(1)}k tokens `
  + `of ~40k budget${ctxTok > VERIFIED_OBEDIENT_TOKENS ? `  ⚠ past ~${VERIFIED_OBEDIENT_TOKENS / 1000}k, the largest pack every member was VERIFIED obedient at` : ''}`);
for (const f of ctx.files) log(`    + ${f}`);
for (const r of ctx.refused) log(`    ✗ ${r}`);
if (!ctx.files.length) {
  log('    ⚠ No context passed. The members cannot see this repo. For any question about');
  log('      THIS codebase, pass --context <files> or you will get five informed guesses.');
}

log(`▸ Env      — ${Object.keys(memberEnv).length} variables passed to members, ${envDropped} withheld`
  + ` (an allowlist: nothing shaped like a credential reaches a member's process)`);
if (brief.source) log(`▸ Brief    — ${brief.source}`);
else if (brief.refused) log(`▸ Brief    — ✗ ${brief.refused}`);
else log('▸ Brief    — none found. Write .council/BRIEF.md or AGENTS.md; it is the cheapest quality win available.');

ev('context', {
  files: ctx.files, refused: ctx.refused, chars: ctx.chars, tokens: ctxTok,
  budgetTokens: 40_000, verifiedObedientTokens: VERIFIED_OBEDIENT_TOKENS,
  briefSource: brief.source, briefRefused: brief.refused ?? null,
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
  // BYTES, matching prepare() and the kernel. This call site was still counting characters — the
  // exact confusion prompt-delivery.mjs documents fixing, alive in the warning that exists to give
  // advance notice of it. On a pack full of em-dashes the two differ by 3x, so the warning said
  // "comfortably within the limit" about a prompt that would be refused.
  const est = Buffer.byteLength(preamble, 'utf8') + Buffer.byteLength(question, 'utf8') + 2_000;
  const ceiling = argvCeiling();
  log(`\n▸ Delivery — ${argvOnly.map((m) => m.label).join(', ')} can only be given the prompt through argv.`);
  log(`             ~${est.toLocaleString()} bytes against this platform's ~${ceiling.toLocaleString()} limit`
    + `${est > ceiling * 0.8 ? '  ⚠ close to it' : ''}`);
  if (est > ceiling) log(`             ⚠ over the limit — ${argvOnly.map((m) => m.id).join(', ')} will be refused rather than crash`);
  // Stage 2 is the larger prompt by a wide margin: the same preamble PLUS every member's full answer.
  // Estimating only stage 1 meant the argv member could clear it, the whole council could spend a
  // stage, and only then would that member be refused — the pre-spend warning arriving after the
  // spend. 3,000 chars/answer is a floor from observed runs; real answers are longer, so this
  // under-states rather than over-states.
  const est2 = est + members.length * 3_000;   // bytes, same basis
  if (est2 > ceiling && est <= ceiling) {
    log(`             ⚠ stage 1 fits but stage 2 will not (~${est2.toLocaleString()} bytes once every`);
    log(`               answer is appended). ${argvOnly.map((m) => m.id).join(', ')} would be refused THEN,`);
    log(`               after stage 1 had already been paid for. Send fewer files, or drop it now.`);
  }
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
    ? P.rubric(preamble, question, question, lenses[m.id])
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
// **`--rubric --revise` used to destroy the scores silently.**
//
// After stage 1b, `good` holds the REVISED answers — and the revision prompt asks for a better answer,
// not for the rubric format. So every `SCORE:` line vanished, `aggregateScores` found nothing, and the
// run reported "no judge produced a parseable OVERALL" as though the judges had failed to comply. A
// silent wrong answer, which this project ranks above a crash.
//
// Rubric mode now gets a revision prompt that re-states the format, so a second pass improves the
// grading instead of erasing it.
if (has('revise') && good.length > 1) {
  ev('stage_start', { stage: '1b', members: good.map((o) => o.id), hint: 'revision — each sees the others and answers again' });

  // A DISTINCT ordering per member, exactly as stage 2 does.
  //
  // This built one board and gave it to everybody, which is precisely the flaw this project
  // criticises the original for: "his labels responses A,B,C… in a fixed order for everyone, so
  // position bias points the same way for every reviewer and compounds." Stage 2 was fixed and
  // stage 1b was not, so the round whose whole purpose is letting members influence each other
  // applied a shared, invisible tilt to which answer each of them read first.
  let reviseFailed = 0;
  revised = await Promise.all(good.map(async (o) => {
    const order = shuffled(good, `1b::${question}::${o.id}`);
    const board = order.map((x, i) => `### Response ${String.fromCharCode(65 + i)}\n\n${x.text}`).join('\n\n---\n\n');
    const m = members.find((x) => x.id === o.id);
    const r = await ask(m, rubricMode
      ? P.rubric1b(preamble, question, board, lenses[o.id])
      : P.stage1b(preamble, question, board, lenses[o.id]), { stage: '1b' });
    // Falling back to the first answer is right — a council of four beats a council that died — but
    // it must not be reported as a successful revision. `failed: 0` was hardcoded, and because the
    // fallback object carries ok:true from stage 1, the success count included every failure.
    if (!r.ok) { reviseFailed++; return { ...o, revisionFailed: r.text }; }
    return r;
  }));
  ev('stage_done', { stage: '1b', ok: revised.length - reviseFailed, failed: reviseFailed });
  if (reviseFailed) {
    log(`  ⚠ ${reviseFailed} member(s) failed to revise; their FIRST answer was kept and is marked in the run file.`);
  }
  good = revised;
}

// ── Stage 2 — anonymised, per-reviewer order, machine-parseable ranking ───────
// `parseRanking` lives in diagnostics.mjs so the tests can import the real thing instead of
// reimplementing it — the test file used to keep its own copy, which pins the behaviour but cannot
// catch this file drifting away from it.
let reviews = [];
let tally = null;
let warnedStage2 = false;

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

    const prompt2 = P.stage2(preamble, question, body);
    // The pre-run warning only ever measured the stage-1 pack, and stage 2 is categorically the
    // largest prompt of the run: the same preamble PLUS every member's full answer. So the one stage
    // most likely to cross the instruction-following ceiling was the one nothing checked.
    const tok2 = Math.round(prompt2.length / 4);
    if (tok2 > VERIFIED_OBEDIENT_TOKENS && !warnedStage2) {
      warnedStage2 = true;
      log(`  ⚠ the stage-2 prompt is ~${(tok2 / 1000).toFixed(1)}k tokens — past the ~${VERIFIED_OBEDIENT_TOKENS / 1000}k every`);
      log(`    member was verified obedient at. A reviewer that stops following the format here shows`);
      log(`    up as a missing FINAL RANKING block, not as an error.`);
    }
    const r = await ask(members.find((m) => m.id === o.id), prompt2, { stage: '2' });

    // Map this reviewer's letters back to member ids before the permutation is forgotten. A label
    // that was never offered to this reviewer is dropped here rather than in the parser — the
    // parser cannot know which letters this permutation used.
    const parsed = rankedLabels(r.text)
      .filter((L) => letters.includes(L))
      .map((L) => order[letters.indexOf(L)]?.id)
      .filter(Boolean);

    // Only from a review that actually succeeded. `r.text` on a failure is an error message or a
    // quota notice, and harvesting a "minority view" out of that put a CLI's diagnostic into the
    // section a chairman is told to weigh most carefully.
    // Decoration-tolerant, like every other labelled field: a reviewer that bolds or bullets these
    // means the same thing, and losing them means losing the section a chairman is told to weigh most.
    const minority = r.ok ? labelled(r.text, 'MINORITY VIEW WORTH KEEPING') : null;
    const lost = r.ok ? labelled(r.text, 'WHAT IS LOST IF THE TOP ANSWER WINS') : null;

    return { ...r, mine, order: order.map((x) => x.id), parsed, minority, lost };
  }));
  ev('stage_done', { stage: '2', ok: reviews.filter((r) => r.ok).length, failed: reviews.filter((r) => !r.ok).length });

  const ids = good.map((o) => o.id);
  // Only reviews that SUCCEEDED. A failed review's `text` is an error message or a quota notice, and
  // `rankedLabels` will happily find "Response A" in one if the CLI happened to echo the prompt back.
  // The tally must not be reachable from output the run already classified as not-an-answer.
  const b = borda(reviews.filter((r) => r.ok), ids);
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
// Measured on the FIRST answers, always — even under --revise.
//
// `good` becomes the revised answers after stage 1b, and the revision round exists precisely to let
// members converge: each one is handed the others' answers and asked to take what is right in them.
// Computing "are these five arguments or one" on that output makes the headline diagnostic fire on
// the convergence the flag was chosen to produce. The independent round is the only one where the
// question means anything.
const overlapBasis = opinions.filter((o) => o.ok);
const overlap = reasoningOverlap(overlapBasis.map((o) => ({ id: o.id, text: o.text })), packText);
// **Two sets, because there are two answers per member under --revise.**
//
// `good` becomes the REVISED answers after stage 1b, so a single `confidences` map keyed by member id
// held revised numbers — and the Stage 1 section, which prints the FIRST answer, labelled it with them.
// A member that said 60% alone and 85% after seeing the others was shown as 85% confident in the answer
// it gave at 60%. Three separate rounds of grading named this; it is fixed rather than noted because
// "the confidence next to this text is not this text's confidence" is a quiet falsehood in the record.
const firstConfidences = Object.fromEntries(opinions.filter((o) => o.ok).map((o) => [o.id, parseConfidence(o.text)]));
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
// No mkdir here. `safeWrite` creates the directory itself, AFTER checking it — this call ran before
// the boundary, so a repo shipping `.council` as a symlink got a directory created at the target
// before anything was validated. The one-boundary rule means the boundary also owns mkdir.
const file = path.join(OUT_DIR, `${slug}.md`);
const byId = Object.fromEntries(good.map((o) => [o.id, o.label]));

const pct = (x) => `${Math.round(100 * x)}%`;
const confLine = (id, from = confidences) => {
  const c = from[id];
  if (!c || c.confidence === null) return '_did not state a confidence_';
  return `**${c.confidence}%**${c.changeMind ? ` — would change its mind if: ${c.changeMind}` : ''}`;
};

const jsonFile = file.replace(/\.md$/, '.json');

const md = [
  `# Council — ${question}`,
  ``,
  `> ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${good.length}/${requested.length} answered`
    + `${useLenses ? ' · lensed' : ''}${rubricMode ? ' · rubric' : ''}`,
  ...(ctx.files.length
    ? [`> **Context:** ${ctx.files.map((f) => `\`${f}\``).join(', ')} — ~${ctxTok} tokens`]
    : [`> **No context was passed.** Every answer below is reasoning about code the members could not read.`]),
  ...(ctx.refused.length ? [`> **Refused:** ${ctx.refused.join('; ')}`] : []),
  ...(brief.refused ? [`> **Brief refused:** ${brief.refused}`] : []),
  ...(usingLocal ? [`> **⚠ Repo-local roster** (\`--local-roster\`) — \`contained\` was stripped from it.`] : []),
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
    ...(tally.degenerate ? [
      `> **⚠ This tally carries no information.** With only ${good.length} answers and self-votes`,
      `> excluded, each reviewer ranks exactly one other, so every member scores the same 1.00 whoever`,
      `> it preferred. The number below is structurally constant, not close. **Read the answers.**`,
      ``,
    ] : []),
    `| Member | Score | Ranked by | Answer length | Confidence |`,
    `|---|---|---|---|---|`,
    ...Object.entries(tally.scores).sort((a, b) => b[1] - a[1])
      .map(([id, s]) => `| ${byId[id]} | ${s.toFixed(2)} | ${tally.ranked?.[id] ?? 0}/${tally.counted} | ${tally.lengths[id]} chars | ${confidences[id]?.confidence ?? '—'} |`),
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
    `| **Family mix** | ${Object.entries(tally.families).map(([f, n]) => `${f} ${n}`).join(', ')} | even | ${familyMajority(tally.families, good.length) ? '⚠ one family holds half or more' : 'ok'} |`,
  ] : [
    `| **Family mix** | ${Object.entries(familyMix(good.map((o) => members.find((m) => m.id === o.id) ?? { family: 'unknown' }))).map(([f, n]) => `${f} ${n}`).join(', ')} | even | |`,
  ]),
  `| **Reasoning overlap** — shared vocabulary with the pack's own terms removed | ${overlap.distinctive === null ? `n/a — ${overlap.thin ? 'answers too short to measure' : 'fewer than two answers'}` : overlap.distinctive.toFixed(2)} | lower is more independent | ${overlap.distinctive !== null && overlap.distinctive > OVERLAP_SUSPECT ? '⚠ they may be one argument, not five' : 'ok'} |`,
  `| **Raw overlap** — before removing the pack's vocabulary | ${overlap.raw === null ? 'n/a' : overlap.raw.toFixed(2)} | — | shown so the correction is visible |`,
  // A number computed over a subset has to say so where the number is, not in a field only the JSON
  // sibling carries. Two members compared out of four is a different fact from four out of four.
  ...(overlap.excluded?.length ? [
    `| **Overlap basis** | ${overlap.usableN} of ${overlap.n} members | all of them | ⚠ ${overlap.excluded.join(', ')} had too little distinctive text to compare |`,
  ] : []),
  `| **Confidence** — members stating one | ${Object.values(confidences).filter((c) => c.confidence !== null).length}/${good.length} | ${good.length}/${good.length} | |`,
  `| **Mean confidence** | ${(() => { const v = Object.values(confidences).map((c) => c.confidence).filter((x) => x !== null); return v.length ? `${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}%` : 'n/a'; })()} | — | ${(() => { const v = Object.values(confidences).map((c) => c.confidence).filter((x) => x !== null); return v.length && v.reduce((a, b) => a + b, 0) / v.length < 65 ? '⚠ agreement at low confidence is a request for more context' : 'ok'; })()} |`,
  ``,
  ...(tally ? [
    `**Self-votes are excluded from the score above.** They were measured on the first real run and`,
    `they dominate: 3 of 4 judges ranked their own unlabelled answer first — 75% against a 20%`,
    `chance rate. **Anonymisation does not prevent self-enhancement**; a model recognises its own`,
    // The number of reviews that actually PARSED, not the member count. The claim was arithmetic on
    // roster size and stayed at "judged by 3 independent readers" when two reviews had failed.
    `writing. In this run each answer was judged by ${Math.max(0, tally.counted - 1)} independent `
      + `${tally.counted - 1 === 1 ? 'reader' : 'readers'} (${tally.counted} of ${tally.total} reviews parsed).`,
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
      const blocks = labelledAll(src?.text ?? '', 'FINDING');
      return [
        `### ${j.label} — overall ${j.overall ?? '—'}/10, confidence ${confidences[j.id]?.confidence ?? '—'}`,
        ``,
        ...(blocks.length ? blocks.map((b) => `- ${b}`) : ['_no parseable FINDING: lines — see its full answer below_']),
        ``,
        ...(labelled(src?.text ?? '', 'SINGLE BIGGEST WIN')
          ? [`**Biggest win, in its view:** ${labelled(src.text, 'SINGLE BIGGEST WIN')}`, ``]
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
    `*${Math.round(o.ms / 1000)}s · confidence ${o.ok ? confLine(o.id, firstConfidences) : 'n/a'}*`, ``,
    // Redacted here too. The event stream's failure reason was fixed and this was not, so the
    // durable file kept the unredacted copy — the worse of the two places for it to live.
    o.ok ? o.text : `> ${redactLine(o.text.split('\n')[0], 300)}`, ``, `---`, ``,
  ]),
  ...(revised ? [
    `## Stage 1b — after seeing each other`,
    ``,
    `Mixture-of-Agents: a model given the others' answers produces a better one. **What changed is`,
    `the signal** — a member that reversed itself here is worth more attention than one that`,
    `restated its first answer at greater length.`,
    ``,
    ...revised.flatMap((o) => [
      `### ${o.label}${o.revisionFailed ? ' — REVISION FAILED, first answer shown' : ''}`, ``,
      ...(o.revisionFailed ? [`> Could not revise: ${o.revisionFailed.split('\n')[0].slice(0, 120)}`, ``] : []),
      `*confidence ${confLine(o.id)}*`, ``,
      o.text, ``, `---`, ``,
    ]),
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
      ``, r.ok ? r.text : `> ${redactLine(r.text.split('\n')[0], 300)}`, ``, `---`, ``,
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

// Both run files go through the one boundary in safe-write.mjs, which refuses a symlinked leaf AND a
// destination directory that resolves outside the workspace. The per-site `lstat` this replaces
// checked only the leaf, so a symlinked `.council/runs/` redirected every file in it while each
// individual check came back clean — the leaves did not exist yet.
const written = safeWrite(file, md, ROOT);
if (!written.ok) {
  log(`\n  ⚠ ${written.reason}`);
  ev('run_error', { message: written.reason });
  clearInterval(ticker); emitter.close(); render.finish();
  process.exit(1);
}

// A structured sibling of the markdown, for anything that is not a human. The markdown is the
// record; this is the same run in a shape a UI, a diff, or a later measurement can index without
// parsing prose.
const jsonWritten = safeWrite(jsonFile, `${JSON.stringify({
  schema: SCHEMA,
  question,
  at: new Date().toISOString(),
  flags: { lenses: useLenses, rubric: rubricMode, revise: has('revise'), stage1Only, timeoutMin },
  context: { files: ctx.files, refused: ctx.refused, tokens: ctxTok, brief: brief.source,
    briefRefused: brief.refused ?? null, verifiedObedientTokens: VERIFIED_OBEDIENT_TOKENS },
  roster: { path: rosterPath, local: usingLocal, localIgnored: localRosterIgnored },
  members: requested.map((m) => ({ id: m.id, label: m.label, family: m.family ?? 'unknown', via: deliveryOf(m), present: members.includes(m) })),
  // The first answer's own confidence, not the revised one. `revised` below carries that.
  opinions: opinions.map((o) => ({ id: o.id, ok: o.ok, ms: o.ms, chars: o.text.length,
    lens: lenses[o.id]?.id ?? null, ...(firstConfidences[o.id] ?? {}) })),
  revised: revised ? revised.map((o) => ({ id: o.id, ok: o.ok, ms: o.ms, chars: o.text.length,
    revisionFailed: o.revisionFailed ? true : false, ...(confidences[o.id] ?? {}) })) : null,
  reviews: reviews.map((r) => ({ id: r.id, ok: r.ok, ms: r.ms, parsed: r.parsed, minority: r.minority ?? null, lost: r.lost ?? null })),
  tally, overlap, rubric: rubricAgg, rubricPerJudge,
}, null, 2)}\n`, ROOT);
if (!jsonWritten.ok) log(`\n  ⚠ the JSON sibling was not written: ${jsonWritten.reason}`);

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
// Only if it actually was. The JSON write's failure was logged and then the summary listed the file
// anyway, so a reader was told a path existed that did not.
if (jsonWritten.ok) log(`           ${path.relative(ROOT, jsonFile)}`);
else log(`           (the JSON sibling was NOT written — see the warning above)`);
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
