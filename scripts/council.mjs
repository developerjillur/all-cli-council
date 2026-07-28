#!/usr/bin/env node
// The council — five models, four vendors, three stages, no API.
//
// Adapted from karpathy/llm-council (23,287★, no licence — so this is written from its
// described algorithm, not copied). His shape: every model answers, every model ranks the
// others anonymised, a chairman synthesises.
//
// Four things here differ, and three of them are because his council answers general
// questions while this one answers questions about a specific codebase.
//
//   1. CONTEXT IS ASSEMBLED AND PASSED.  His members need none — the question is
//      self-contained. Ours were given the question and nothing else, which made them five
//      confident guesses about code none of them had read. See context.mjs for why the
//      obvious fix (run them in the repo, read-only) is one this project has already
//      disproven: read-only means cannot WRITE.
//   2. THE ORDER IS SHUFFLED PER REVIEWER.  His labels responses A,B,C… in a fixed order for
//      everyone, so position bias points the same way for every reviewer and compounds. Each
//      reviewer here sees its own permutation, seeded from the question so a run is
//      reproducible. This is not parity with the original — it is better than it.
//   3. RANKINGS ARE PARSED AND AGGREGATED.  His forces a FINAL RANKING: block and parses it;
//      the first version here asked for prose and could not tell you who won. Borda count,
//      reported with its own health warning.
//   4. STAGE 3 IS NOT A SUBPROCESS.  His chairman is another API call. Ours is the session
//      that ran the council, so the synthesis happens with the conversation in context.
//
//   node scripts/council/council.mjs "<question>" [--context file ...] [--card <path>]
//                                    [--stage1-only] [--members=id,id]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildContext, loadBrief } from './context.mjs';
import { judgeOutput } from './judge-output.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
// Members: the project's own roster if it has one, otherwise the packaged default.
const localRoster = path.join(process.cwd(), '.council', 'members.json');
const rosterPath = fs.existsSync(localRoster) ? localRoster : path.join(HERE, 'members.json');
const CFG = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
const OUT_DIR = path.join(ROOT, '.council', 'runs');

// ── arguments ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const ctxFiles = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--context' || argv[i] === '--card') {
    while (argv[i + 1] && !argv[i + 1].startsWith('--')) ctxFiles.push(argv[++i]);
  }
}
const question = argv.filter((a, i) => !a.startsWith('--') && !ctxFiles.includes(a)).join(' ').trim();
const stage1Only = argv.includes('--stage1-only');
const only = flag('members')?.split(',');

if (!question) {
  console.error('Usage: council.mjs "<question>" [--context <file>...] [--stage1-only] [--members=id,id]');
  process.exit(1);
}

const scratch = CFG.scratchDir.replace('~', os.homedir());
fs.mkdirSync(scratch, { recursive: true });
const log = (s) => process.stderr.write(`${s}\n`);

// ── pre-flight ───────────────────────────────────────────────────────────────
//
// Find out who is here BEFORE spending anything. A member whose CLI is not installed used to
// be discovered mid-run, after the others had already started, and the failure arrived mixed
// in with real answers.
//
// **Nothing is ever retried.** A CLI that is missing now will be missing in thirty seconds,
// and a quota that is exhausted does not refill while you wait. Retrying would turn a clear
// answer — "you have four of five" — into an indefinite hang, which is the failure this whole
// section exists to prevent. Report, and go.
function onPath(cmd) {
  if (cmd.includes('/')) return fs.existsSync(cmd);
  const dirs = [`${os.homedir()}/.local/bin`, `${os.homedir()}/.npm-global/bin`,
    '/usr/local/bin', '/opt/homebrew/bin', ...(process.env.PATH ?? '').split(':')];
  return dirs.some((d) => d && fs.existsSync(path.join(d, cmd)));
}

const requested = CFG.members.filter((m) => !only || only.includes(m.id));
const members = requested.filter((m) => onPath(m.cmd));
const absent = requested.filter((m) => !onPath(m.cmd));

if (absent.length) {
  log(`\n▸ Not installed on this machine — skipped, not retried:`);
  for (const m of absent) log(`    ✗ ${m.label} (\`${m.cmd}\` not found)`);
}

if (!members.length) {
  log(`\n  No council member is available on this machine.`);
  log(`  Requested: ${requested.map((m) => m.cmd).join(', ')}`);
  log(`\n  Install one, or run with --members=<id> for those you do have.`);
  log(`  Nothing was spent and nothing was written.\n`);
  process.exit(2);   // 2 = could not convene, distinct from 1 = convened and all failed
}

if (argv.includes('--preflight')) {
  log(`\n  ${members.length}/${requested.length} member(s) available: ${members.map((m) => m.label).join(', ')}`);
  log('  Pre-flight only — nothing was run.\n');
  process.exit(0);
}

if (members.length < requested.length) {
  log(`\n  Continuing with ${members.length} of ${requested.length}. A smaller council is a`);
  log('  weaker one — fewer independent readers, and the tally means less.');
}

// ── context ──────────────────────────────────────────────────────────────────
const ctx = buildContext(ctxFiles, ROOT);
const ctxTok = Math.round(ctx.chars / 4);
// The budget is shown every run, because the failure at the ceiling is silent: at ~80k one
// member stopped following instructions rather than erroring. Measured 2026-07-28.
log(`\n▸ Context — ${ctx.files.length} file(s), ~${(ctxTok / 1000).toFixed(1)}k tokens `
  + `of ~40k budget${ctxTok > 27_000 ? '  ⚠ past the size every member was verified obedient at' : ''}`);
for (const f of ctx.files) log(`    + ${f}`);
for (const r of ctx.refused) log(`    ✗ ${r}`);
if (!ctx.files.length) {
  log('    ⚠ No context passed. The members cannot see this repo. For any question about');
  log('      THIS codebase, pass --context <files> or you will get five informed guesses.');
}

const brief = loadBrief(ROOT);
if (brief.source) log(`▸ Brief    — ${brief.source}`);
else log('▸ Brief    — none found. Write .council/BRIEF.md or AGENTS.md; it is the cheapest quality win available.');
const preamble = [brief.text, ctx.text].filter(Boolean).join('\n\n---\n\n');

// ── a seeded shuffle, so a run is reproducible but position bias is not shared ────
function shuffled(arr, seedStr) {
  let h = parseInt(crypto.createHash('sha256').update(seedStr).digest('hex').slice(0, 12), 16);
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) % 2147483648;
    const j = h % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Run one member. **Never rejects, and never leaves the process hanging.**
 *
 * A council of four beats a council that died, so a failure here is a result rather than an
 * exception. And it must not be able to hold the run open: a child that ignores SIGTERM kept
 * the parent's event loop alive after the promise had already resolved — the council finished
 * and the process sat there. SIGKILL follows, and the child is unref'd so node can exit.
 */
function ask(member, prompt, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  const args = member.args.map((a) => a.replace('{prompt}', prompt));
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (ok, text) => {
      if (done) return;
      done = true;
      resolve({ id: member.id, label: member.label, ok, text: String(text).trim(), ms: Date.now() - started });
    };

    let p;
    try {
      // `detached: true` puts the child in its own process GROUP, so the timeout can kill
      // everything it spawned rather than only the process we can see.
      //
      // Found by testing: killing the child left its grandchild alive, still holding the
      // inherited stdout pipe, so the parent's event loop never drained and the run hung
      // anyway — 15s instead of the 329ms the earlier fix had achieved. Every member here is
      // a CLI that shells out, so this is the normal case rather than an edge one.
      p = spawn(member.cmd, args, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      finish(false, `could not start ${member.cmd}: ${e.message}`);
      return;
    }

    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('error', () => {});          // EPIPE if the child dies mid-write
    p.stderr.on('error', () => {});
    p.on('error', (e) => finish(false, `could not start ${member.cmd}: ${e.message}`));
    p.on('close', (c) => finish(...judgeOutput(out, err, c)));

    // Kill the whole group (negative pid), falling back to the single process if the group
    // is already gone. SIGTERM is a request; SIGKILL five seconds later is not.
    const stop = (sig) => {
      try { process.kill(-p.pid, sig); } catch {
        try { p.kill(sig); } catch { /* already gone */ }
      }
    };

    const t = setTimeout(() => {
      stop('SIGTERM');
      const hard = setTimeout(() => {
        stop('SIGKILL');
        // Detach the streams too: a grandchild we failed to reach must not keep the event
        // loop alive through an inherited pipe.
        try { p.stdout.destroy(); p.stderr.destroy(); p.unref(); } catch { /* gone */ }
      }, 5_000);
      hard.unref?.();
      finish(false, `timed out after ${Math.round(timeoutMs / 60000)} min`);
    }, timeoutMs);
    t.unref?.();
    p.on('close', () => clearTimeout(t));
  });
}

// ── Stage 1 ──────────────────────────────────────────────────────────────────
log(`\n▸ Stage 1 — ${members.length} members, in parallel. Minutes, not seconds.`);
const opinions = await Promise.all(members.map(async (m) => {
  const r = await ask(m, `${preamble}\n\n---\n\n## The question\n\n${question}\n\n`
    + `Answer directly and concretely, grounded in the context above where it applies. State your `
    + `reasoning. If the context does not contain what you would need, say exactly what is missing `
    + `rather than assuming it. Do not hedge to sound safe.`);
  log(`  ${r.ok ? '✅' : '❌'} ${r.label} — ${Math.round(r.ms / 1000)}s${r.ok ? '' : ` — ${r.text.slice(0, 70)}`}`);
  return r;
}));

let good = opinions.filter((o) => o.ok);
if (!good.length) { log('\n  Every member failed.'); process.exit(1); }

// ── Stage 1b · revision, opt-in ──────────────────────────────────────────────
//
// Mixture-of-Agents (arXiv 2406.04692) reports the effect this exploits: a model given other
// models' answers produces a better one than it did alone. That is a second full round —
// five more calls, minutes each — so it is behind a flag rather than on by default.
//
// The revised answers replace the originals for ranking. The originals stay in the file,
// because "what changed once they saw each other" is often the most informative thing in it.
let revised = null;
if (argv.includes('--revise') && good.length > 1) {
  log(`\n▸ Stage 1b — revision. Each member sees the others and answers again.`);
  const board = good.map((o, i) => `### Response ${String.fromCharCode(65 + i)}\n\n${o.text}`).join('\n\n---\n\n');
  revised = await Promise.all(good.map(async (o) => {
    const prompt = `${preamble}\n\n---\n\n## The question\n\n${question}\n\n`
      + `## Answers from other responders (anonymous, one is yours)\n\n${board}\n\n`
      + `## Your task\n\nAnswer the question again, better. Take what is right in the others; `
      + `say plainly where one of them is wrong rather than blending it in. **If your first answer `
      + `was wrong, say so and correct it** — that is worth more here than consistency. If none `
      + `of them changed your view, say that and do not pad the answer to look like it did.`;
    const r = await ask(members.find((m) => m.id === o.id), prompt);
    log(`  ${r.ok ? '✅' : '❌'} ${r.label} revised — ${Math.round(r.ms / 1000)}s`);
    return r.ok ? r : o;
  }));
  good = revised;
}

// ── Stage 2 — anonymised, per-reviewer order, machine-parseable ranking ───────
// The LAST `FINAL RANKING:` that starts a line, not the first anywhere.
//
// Probed 2026-07-28: a reviewer that quotes another response's ranking block — or a stage-1
// answer that happens to contain one — spoofed the parser, because `/FINAL RANKING:[\s\S]*/`
// takes everything after the FIRST occurrence. The prompt says "finish with exactly this block
// and nothing after it", so the last line-anchored block is the reviewer's own verdict.
function parseRanking(text) {
  const starts = [...text.matchAll(/^[^\S\n]*FINAL RANKING:/gim)];
  if (!starts.length) return '';
  return text.slice(starts[starts.length - 1].index + starts[starts.length - 1][0].length);
}
let reviews = [];
let tally = null;

if (!stage1Only && good.length > 1) {
  log(`\n▸ Stage 2 — anonymised peer review, each reviewer sees its own ordering.`);

  reviews = await Promise.all(good.map(async (o) => {
    // A distinct permutation per reviewer: position bias no longer points the same way for
    // everyone, so it shows up as disagreement instead of as a shared, invisible tilt.
    const order = shuffled(good, `${question}::${o.id}`);
    const letters = order.map((_, i) => String.fromCharCode(65 + i));
    const mine = letters[order.findIndex((x) => x.id === o.id)];
    const body = order.map((x, i) => `### Response ${letters[i]}\n\n${x.text}`).join('\n\n---\n\n');

    const prompt = `${preamble}\n\n---\n\n`
      + `Several anonymous responders answered the question below. Rank them.\n\n`
      + `## The question\n\n${question}\n\n## The responses\n\n${body}\n\n`
      + `## Your task\n\n`
      + `For each response: one line on what it gets right, one on what it gets wrong or misses. `
      + `Judge **accuracy first, insight second** — an elegant answer that violates a rule in the `
      + `brief above is wrong, not clever.\n\n`
      + `Then state, in one sentence, the single most important thing **all** of them missed. `
      + `If they missed nothing, say so plainly rather than inventing a gap.\n\n`
      + `One of these is yours. Judge it by the same standard.\n\n`
      + `Finish with EXACTLY this block and nothing after it:\n\n`
      + `FINAL RANKING:\n1. Response X\n2. Response Y\n(best to worst, label only, one per line)`;

    const r = await ask(members.find((m) => m.id === o.id), prompt);
    log(`  ${r.ok ? '✅' : '❌'} ${r.label} reviewed — ${Math.round(r.ms / 1000)}s`);

    // Map this reviewer's letters back to member ids before the permutation is forgotten.
    // Also de-duplicated: a reviewer that lists the same label twice would otherwise get two
    // Borda votes for it, and one member's sloppiness would outweigh another's care.
    const seenLabels = new Set();
    const parsed = parseRanking(r.text)
      .split('\n').map((l) => l.match(/Response\s+([A-Z])\b/i)?.[1])
      .filter(Boolean)
      .map((L) => L.toUpperCase())
      .filter((L) => letters.includes(L) && !seenLabels.has(L) && seenLabels.add(L))
      .map((L) => order[letters.indexOf(L)]?.id)
      .filter(Boolean);

    return { ...r, mine, order: order.map((x) => x.id), parsed };
  }));

  // Borda count — with self-votes REMOVED, because they were measured and they dominate.
  //
  // On the first real run, 3 of 4 judges ranked their own (unlabelled) answer first: 75%
  // against a 20% chance rate, mean self-rank 1.5 against an unbiased 3.0. Anonymisation
  // does not prevent self-enhancement — a model recognises its own writing. So a tally that
  // counts self-votes is measuring style recognition as much as quality.
  //
  // Dropping the self-vote and re-ranking what remains is the standard mitigation, and it
  // costs nothing: every answer is still judged by four independent readers.
  const scores = Object.fromEntries(good.map((o) => [o.id, 0]));
  let counted = 0;
  let selfFirst = 0;
  let selfRanks = [];
  for (const r of reviews) {
    if (r.parsed.length < 2) continue;
    counted++;
    const selfPos = r.parsed.indexOf(r.id);
    if (selfPos >= 0) { selfRanks.push(selfPos + 1); if (selfPos === 0) selfFirst++; }
    const others = r.parsed.filter((id) => id !== r.id);
    others.forEach((id, i) => { if (id in scores) scores[id] += others.length - i; });
  }

  // Diagnostics printed with the tally, so nobody has to remember to look for them.
  const lengths = Object.fromEntries(good.map((o) => [o.id, o.text.length]));
  const pairs = Object.keys(scores).map((id) => ({ s: scores[id], c: lengths[id] }));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(pairs.map((p) => p.s));
  const mc = mean(pairs.map((p) => p.c));
  const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0));
  const denom = sd(pairs.map((p) => p.s), ms) * sd(pairs.map((p) => p.c), mc);
  const lengthR = denom ? pairs.reduce((s, p) => s + (p.s - ms) * (p.c - mc), 0) / denom : 0;

  // Family bias is real and ours is lopsided by construction: two Claude members plus a
  // Claude chairman. Stated rather than corrected — the fix is a different council, and
  // that is a decision, not something a script should make quietly.
  const families = {};
  for (const o of good) {
    const fam = o.id.startsWith('claude') ? 'Anthropic'
      : o.id === 'codex' ? 'OpenAI' : o.id === 'grok' ? 'xAI' : 'Google';
    families[fam] = (families[fam] ?? 0) + 1;
  }

  tally = {
    scores, counted, total: reviews.length, lengths, lengthR, families,
    selfFirst, selfN: selfRanks.length,
    selfMean: selfRanks.length ? mean(selfRanks) : null,
  };
}

// ── the record ───────────────────────────────────────────────────────────────
const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${slug || 'council'}.md`);
const byId = Object.fromEntries(good.map((o) => [o.id, o.label]));

const md = [
  `# Council — ${question}`,
  ``,
  `> ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${good.length}/${members.length} answered`,
  ...(ctx.files.length
    ? [`> **Context:** ${ctx.files.map((f) => `\`${f}\``).join(', ')} — ~${Math.round(ctx.chars / 4)} tokens`]
    : [`> **No context was passed.** Every answer below is reasoning about code the members could not read.`]),
  ...(ctx.refused.length ? [`> **Refused:** ${ctx.refused.join('; ')}`] : []),
  ``,
  ...(tally ? [
    `## Aggregate — Borda over ${tally.counted}/${tally.total} rankings, **self-votes excluded**`,
    ``,
    `| Member | Score | Answer length |`,
    `|---|---|---|`,
    ...Object.entries(tally.scores).sort((a, b) => b[1] - a[1])
      .map(([id, s]) => `| ${byId[id]} | ${s} | ${tally.lengths[id]} chars |`),
    ``,
    `### Bias diagnostics — read these before the score`,
    ``,
    `| | This run | Unbiased | |`,
    `|---|---|---|---|`,
    `| **Self-enhancement** — judges ranking their own answer 1st | ${tally.selfN ? `${tally.selfFirst}/${tally.selfN} (${Math.round(100 * tally.selfFirst / tally.selfN)}%)` : 'n/a'} | ${Math.round(100 / good.length)}% | ${tally.selfN && tally.selfFirst / tally.selfN > 1.5 / good.length ? '⚠ present' : 'ok'} |`,
    `| **Mean self-rank** | ${tally.selfMean ? tally.selfMean.toFixed(1) : 'n/a'} | ${((good.length + 1) / 2).toFixed(1)} | |`,
    `| **Verbosity** — correlation(score, answer length) | ${tally.lengthR.toFixed(2)} | 0.00 | ${Math.abs(tally.lengthR) > 0.5 ? '⚠ length is doing work' : 'ok'} |`,
    `| **Family mix** | ${Object.entries(tally.families).map(([f, n]) => `${f} ${n}`).join(', ')} | even | ${Math.max(...Object.values(tally.families)) > good.length / 2 ? '⚠ one family has a majority' : 'ok'} |`,
    ``,
    `**Self-votes are excluded from the score above.** They were measured on the first real run`,
    `and they dominate: 3 of 4 judges ranked their own unlabelled answer first — 75% against a`,
    `20% chance rate. **Anonymisation does not prevent self-enhancement**; a model recognises its`,
    `own writing. Every answer is still judged by four independent readers.`,
    ``,
    `**The chairman is Claude, and so are two members.** Family bias is documented — a judge`,
    `over-rewards its own family — and this council is lopsided by construction. That is stated`,
    `rather than corrected, because the fix is a different council and that is your decision.`,
    ``,
    `**Even clean, this is a popularity number.** Five models on overlapping training data`,
    `agreeing is weak evidence — they share training data, so consensus measures overlap as much as truth.`,
    `Use it to find *where they split*, never to pick the winner.`,
    ``,
  ] : []),
  `---`,
  ``,
  revised ? `## Stage 1 — first opinions (revised versions follow)` : `## Stage 1 — independent opinions`,
  ``,
  ...opinions.flatMap((o) => [
    `### ${o.label}${o.ok ? '' : ' — FAILED'}`, ``, `*${Math.round(o.ms / 1000)}s*`, ``,
    o.ok ? o.text : `> ${o.text}`, ``, `---`, ``,
  ]),
  ...(revised ? [
    `## Stage 1b — after seeing each other`,
    ``,
    `Mixture-of-Agents: a model given the others' answers produces a better one. **What changed`,
    `is the signal** — a member that reversed itself here is worth more attention than one that`,
    `restated its first answer at greater length.`,
    ``,
    ...revised.flatMap((o) => [`### ${o.label}`, ``, o.text, ``, `---`, ``]),
  ] : []),
  ...(reviews.length ? [
    `## Stage 2 — anonymised peer review`,
    ``,
    `**Each reviewer saw its own ordering**, seeded from the question. So position bias does not`,
    `point the same way for everyone — where it exists, it surfaces as disagreement instead of as`,
    `a shared tilt nobody can see. The mapping below de-anonymises after the fact.`,
    ``,
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
  `1. **Where they disagree is the output.** Record both sides; averaging five models produces`,
  `   something none of them would defend.`,
  `2. **Consensus is not correctness** — see the warning under the tally.`,
  `3. **Every number goes through \`skills/measure-dont-claim\`**, however many members said it.`,
  ...(ctx.files.length ? [] : [
    `4. **⚠ No context was passed to this council.** Before using any of it, ask whether the`,
    `   answer would survive the members actually reading the code.`,
  ]),
  ``,
].join('\n');

fs.writeFileSync(file, md);

// ── the report the caller actually needs ─────────────────────────────────────
//
// Printed at the end, in one place, rather than scattered through the run. Someone who looked
// away for ten minutes should be able to tell in one glance whether this council is worth
// reading — and a degraded one must say so rather than presenting four answers as five.
const failed = opinions.filter((o) => !o.ok);
log(`\n${'─'.repeat(64)}`);
log(`  ${good.length}/${requested.length} answered.`);

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

log(`\n▸ Written: ${path.relative(ROOT, file)}\n`);
console.log(file);

// 0 = usable (even if degraded) · 1 = convened and nobody answered · 2 = could not convene.
process.exit(good.length ? 0 : 1);
