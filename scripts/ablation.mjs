#!/usr/bin/env node
// Does the council beat one good model? Run the experiment instead of assuming.
//
//   ablation --corpus questions.json --out runs/            run every arm on every question
//   ablation --score runs/                                  BLIND scoring sheet, treatments hidden
//   ablation --reveal runs/ --scores scores.json            unblind and report
//   ablation --example                                      a corpus file to start from
//
// ── why this file exists ────────────────────────────────────────────────────
//
// This package's README has always carried one open question as its own top item: **nobody has
// shown a council beats one good model.** A four-vendor council reviewing this package put it
// more sharply than the README does:
//
//   "A has built a confidence amplifier before proving it is a correctness amplifier. All
//    participating models inherit the same mistaken premise; anonymous peer ranking selects the
//    most polished expression of that premise; the diagnostic layer finds no anomaly; and the
//    synthesis makes the wrong answer feel independently validated. Until that experiment
//    exists, 'council' describes the ceremony, not the reliability."
//
// That is the correct criticism and it cannot be answered by more machinery. It is answered by
// a measurement, and this is the harness for it.
//
// ── the three arms, and why the middle one matters most ─────────────────────
//
//   solo      the strongest single member, asked the same question with the same context
//   parallel  every member answers independently — NO peer ranking, NO synthesis
//   council   the full pipeline
//
// `parallel` is the arm that decides whether this package earns its complexity. If `council`
// beats `solo` but not `parallel`, then the value was showing a human several independent
// answers, and the ranking, diagnostics and synthesis are ceremony that could be deleted. That
// is a result worth having and this package should publish it either way.
//
// ── what makes it an experiment rather than a demo ──────────────────────────
//
//   · **The treatment is hidden from the scorer.** `--score` writes a sheet with the arms
//     shuffled and labelled A/B/C per question, and a separate key file the scorer never opens.
//     A scorer who knows which answer came from the council will score the council higher; that
//     is not a hypothetical, it is the same self-enhancement this package measures in its own
//     judges at 50% against a 25% baseline.
//   · **The stopping rule is written before the data.** The corpus declares `n` and the
//     decision rule up front, and `--reveal` refuses to report until every question has been
//     scored — so "we stopped when it looked good" is not available.
//   · **A tie is a result.** The rule below treats "no separation" as the finding, because the
//     honest outcome of this experiment may well be that the council does not help.
//
// This harness does not supply ground truth. It cannot: scoring needs decisions whose outcomes
// are known later, or answers checkable against something executable. That is the one part the
// owner must bring, and pretending otherwise would be the exact overclaiming this measures.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => {
  const hit = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : argv[argv.indexOf(hit) + 1] ?? null;
};

const ARMS = ['solo', 'parallel', 'council'];

// ── a corpus to start from ──────────────────────────────────────────────────
if (flag('example')) {
  console.log(JSON.stringify({
    $comment: [
      'A corpus is a set of decisions whose CORRECTNESS becomes knowable — not opinions.',
      'Each needs a `truth` you can check later, or an `evidence` command that settles it.',
      'Declare n and the stopping rule BEFORE running. --reveal enforces both.',
      '',
      'Good questions: ones you already know the answer to but the models do not, or ones whose',
      'outcome lands within weeks. Bad questions: matters of taste, where every arm "wins".',
    ],
    stoppingRule: {
      n: 20,
      decide: 'council wins only if it beats BOTH solo and parallel by >= 15 percentage points '
        + 'on correctness across all 20. Anything less is reported as no separation.',
      preregisteredAt: '<ISO date, before the first run>',
    },
    questions: [
      {
        id: 'q1',
        question: 'Given src/queue.js, can a retry deliver the same job twice? If so, name the interleaving.',
        context: ['src/queue.js', 'src/worker.js'],
        truth: 'Yes — the visibility timeout is renewed after the handler starts, so a slow handler '
          + 'releases the lock before finishing. Named in incident 2026-06-11.',
      },
      {
        id: 'q2',
        question: 'Does this migration survive a rollback to the previous release?',
        context: ['migrations/0042_rename.sql'],
        evidence: 'npm run test:invariant:migration',
      },
    ],
  }, null, 2));
  process.exit(0);
}

const die = (m) => { console.error(`\n  ${m}\n`); process.exit(2); };

// ── phase 1 · run every arm ─────────────────────────────────────────────────
if (val('corpus')) {
  const corpusPath = val('corpus');
  const outDir = val('out') ?? 'ablation-runs';
  let corpus;
  try { corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')); } catch (e) { die(`corpus unreadable — ${e.message}`); }
  const qs = corpus.questions ?? [];
  if (!qs.length) die('the corpus declares no questions.');
  if (!corpus.stoppingRule?.n || !corpus.stoppingRule?.decide) {
    die('the corpus has no stoppingRule {n, decide}. Declaring it AFTER seeing results is how a\n'
      + '  null result becomes a positive one — see --example.');
  }
  if (qs.length < corpus.stoppingRule.n) {
    console.error(`\n  ⚠ the corpus declares n=${corpus.stoppingRule.n} but carries ${qs.length} questions.`);
    console.error('    --reveal will refuse to report until it is complete.\n');
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'corpus.json'), JSON.stringify(corpus, null, 2));
  console.log(`\n  ${qs.length} question(s) × ${ARMS.length} arms. Each council arm is minutes.\n`);

  for (const q of qs) {
    for (const arm of ARMS) {
      const file = path.join(outDir, `${q.id}.${arm}.md`);
      if (fs.existsSync(file)) { console.log(`  ·  ${q.id}/${arm} already run — skipped`); continue; }
      const ctx = (q.context ?? []).flatMap((c) => [`--context=${c}`]);
      // solo and parallel are the same council with stages removed — the arms differ only in
      // how much of the pipeline runs, which is the whole point of an ablation.
      const args = [path.join(HERE, 'council.mjs'), q.question, ...ctx, '--no-live'];
      if (arm === 'solo') args.push('--members=codex');            // the strongest single member
      if (arm !== 'council') args.push('--stage1-only');           // no ranking, no synthesis
      process.stdout.write(`  ▹ ${q.id}/${arm} … `);
      const r = spawnSync('node', args, { encoding: 'utf8', timeout: 40 * 60_000 });
      fs.writeFileSync(file, `${r.stdout ?? ''}\n${r.stderr ?? ''}`);
      console.log(r.status === 0 ? 'done' : `exit ${r.status}`);
    }
  }
  console.log(`\n  Written to ${outDir}/. Next: ablation --score ${outDir}\n`);
  process.exit(0);
}

// ── phase 2 · a BLIND scoring sheet ─────────────────────────────────────────
if (val('score')) {
  const dir = val('score');
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  const sheet = []; const key = {};
  for (const q of corpus.questions) {
    // Shuffled per question, deterministically from the id: reproducible sheet, but the
    // ordering must genuinely VARY across questions or the blind is not blind.
    //
    // The first attempt here sorted by `(seed + arm.length) % 7`, which looks like a shuffle
    // and is not one: the seed is added to every arm equally, so mod-7 shifts all three keys
    // together and the relative order never changes. Every question came out council/parallel/
    // solo, so "A" was always the council and two questions were enough for a scorer to learn
    // it. Caught by running the harness on two questions and reading KEY.json, not by reading
    // the line — the arithmetic reads fine.
    //
    // Indexing a permutation table cannot fail that way: a different seed IS a different order.
    const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const seed = [...q.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const order = PERMS[seed % PERMS.length].map((i) => ARMS[i]);
    const labels = ['A', 'B', 'C'];
    key[q.id] = {};
    const answers = order.map((arm, i) => {
      key[q.id][labels[i]] = arm;
      const f = path.join(dir, `${q.id}.${arm}.md`);
      return { label: labels[i], answer: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(missing)' };
    });
    sheet.push({ id: q.id, question: q.question, truth: q.truth ?? null, evidence: q.evidence ?? null, answers });
  }
  fs.writeFileSync(path.join(dir, 'KEY.json'), JSON.stringify(key, null, 2));
  const sheetPath = path.join(dir, 'SCORING-SHEET.md');
  const body = [
    '# Blind scoring sheet',
    '',
    '**Do not open `KEY.json` until every question is scored.** Which arm produced which answer',
    'is hidden on purpose: a scorer who knows will score the one they expect to win higher, and',
    'this package measures exactly that bias in its own judges at 50% against a 25% baseline.',
    '',
    'For each question, score every answer 0–2 on correctness:',
    '',
    '    0  wrong, or confidently asserts something false',
    '    1  not wrong, but misses the thing that matters',
    '    2  correct AND names the mechanism',
    '',
    'Write them into `scores.json` as `{"<id>": {"A": 0, "B": 2, "C": 1}}`, then:',
    '',
    `    ablation --reveal ${dir} --scores scores.json`,
    '',
    '---',
    '',
    ...sheet.flatMap((s) => [
      `## ${s.id}`, '', s.question, '',
      s.truth ? `**Known outcome:** ${s.truth}` : '',
      s.evidence ? `**Settled by:** \`${s.evidence}\`` : '',
      '',
      ...s.answers.flatMap((a) => [`### ${a.label}`, '', '```', a.answer.slice(0, 6000), '```', '']),
      '---', '',
    ]),
  ].join('\n');
  fs.writeFileSync(sheetPath, body);
  console.log(`\n  ${sheetPath}  — score it, then --reveal.`);
  console.log(`  ${path.join(dir, 'KEY.json')}  — do not open this first.\n`);
  process.exit(0);
}

// ── phase 3 · unblind ───────────────────────────────────────────────────────
if (val('reveal')) {
  const dir = val('reveal');
  const scoresPath = val('scores') ?? path.join(dir, 'scores.json');
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'KEY.json'), 'utf8'));
  let scores;
  try { scores = JSON.parse(fs.readFileSync(scoresPath, 'utf8')); } catch (e) { die(`no scores — ${e.message}`); }

  // The stopping rule, enforced. Reporting on a partial corpus is how "we stopped when it
  // looked good" gets written up as a result.
  const scored = corpus.questions.filter((q) => scores[q.id]);
  if (scored.length < corpus.stoppingRule.n) {
    die(`the corpus declared n=${corpus.stoppingRule.n} and ${scored.length} question(s) are scored.\n`
      + `  Refusing to report. The stopping rule was written before the data for exactly this reason:\n`
      + `  "${corpus.stoppingRule.decide}"`);
  }

  const total = Object.fromEntries(ARMS.map((a) => [a, 0]));
  const max = scored.length * 2;
  for (const q of scored) {
    for (const [label, arm] of Object.entries(key[q.id])) {
      total[arm] += scores[q.id]?.[label] ?? 0;
    }
  }
  const pct = Object.fromEntries(ARMS.map((a) => [a, (total[a] / max) * 100]));
  console.log(`\n${'═'.repeat(66)}\n  ABLATION — ${scored.length} questions, blind-scored\n${'═'.repeat(66)}\n`);
  for (const a of ARMS) console.log(`  ${a.padEnd(10)} ${total[a]}/${max}  ${pct[a].toFixed(1)}%`);
  console.log(`\n  Pre-registered rule: ${corpus.stoppingRule.decide}\n`);

  const lead = pct.council - Math.max(pct.solo, pct.parallel);
  if (lead >= 15) {
    console.log(`  ✅ The council leads its nearest arm by ${lead.toFixed(1)} points — the rule is met.`);
  } else if (pct.parallel >= pct.council - 5 && pct.parallel > pct.solo + 5) {
    console.log(`  ⚠ NO SEPARATION between council and parallel (${lead.toFixed(1)} points).`);
    console.log('     The value was showing several independent answers. Ranking, diagnostics and');
    console.log('     synthesis are not carrying their weight and should be argued for or deleted.');
  } else {
    console.log(`  ❌ The rule is NOT met (${lead.toFixed(1)} points).`);
    console.log('     This is a result, not a failure of the harness. Publish it, and shrink the');
    console.log('     package\'s claim to what the number supports.');
  }
  console.log('\n  Ties and losses are the outcomes this was built to be able to report.\n');
  process.exit(0);
}

console.error(`
  ablation — does the council beat one good model?

    ablation --example > corpus.json          a corpus to start from
    ablation --corpus corpus.json --out runs/ run solo | parallel | council
    ablation --score runs/                    blind scoring sheet
    ablation --reveal runs/ --scores s.json   unblind, against the pre-registered rule

  The middle arm decides whether this package earns its complexity: if council does not
  beat parallel, the value was several independent answers and the rest is ceremony.
`);
process.exit(2);
