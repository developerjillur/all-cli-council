import crypto from 'node:crypto';

// The numbers printed above the score — and one new one that answers a question the README
// previously only asserted.
//
// Split out of council.mjs so every one of them can be tested without spending a council. That is
// not tidiness: these are the numbers a reader uses to decide whether to trust the ranking, and an
// untested bias metric is worse than none, because it is quoted with the same confidence.
//
// ── Why `reasoningOverlap` exists ─────────────────────────────────────────────────────────
//
// Every run file already says *"consensus is not correctness — they share training data, so
// agreement measures overlap as much as truth."* That is true, and it was **prose**. A reader was
// told to discount agreement by an unknown amount, every run, with no way to tell a run where the
// members genuinely converged from one where they produced the same paragraph five times.
//
// `council-review` names this failure "theatrical consensus" and flags reasoning-footprint overlap
// above ~60%. Adopting a raw lexical-overlap threshold directly does not work here, and the reason
// is specific to this council: **our members are all given the same context pack.** Five answers
// about `src/queue.js` share `retry`, `idempotent`, `partition` and every identifier in the file,
// so raw overlap measures *the question* far more than it measures *the reasoning*.
//
// So the metric subtracts the subject matter. Terms that appear in the pack, the brief or the
// question are removed from every answer first; what remains is the vocabulary each member brought
// itself, and overlap is measured only on that. Two members that reasoned independently about the
// same code still differ there; two members that produced the same argument do not.
//
// **The threshold is borrowed and unvalidated on this council.** It is printed with its own n and
// flagged as indicative, in the same spirit as the verbosity correlation — which swung
// 0.64 / −0.18 / 0.53 / 0.06 across four runs and is *printed rather than corrected* for exactly
// this reason. A number with its error bars beside it is harder to quote out of context.

/**
 * Words carrying enough content to be worth comparing.
 *
 * Stopwords and short tokens are dropped because they are shared by all English prose and would
 * drag every pair's similarity toward the same number, which is the opposite of a discriminating
 * metric.
 */
const STOP = new Set(`the a an and or but if then than that this these those is are was were be been
being have has had do does did will would shall should may might must can could of in on at to for
with from by as it its into about over under out up down not no nor so such only own same too very
just also very there here what which who whom when where why how all any both each few more most
other some own s t don now i you he she they we me him her them my your his their our what's
because while during before after above below between through against upon within without along
across behind beyond among however therefore thus hence moreover furthermore additionally rather
whether either neither one two three first second also using used use like well much many
answer question response responses model models`.split(/\s+/));

export function contentTokens(text) {
  const out = new Set();
  // Split on joiners too, and keep BOTH the compound and its parts.
  //
  // The tokeniser kept `src/queue.js` as one token, so an answer writing `queue.js` shared nothing
  // with a pack that wrote `src/queue.js` — the pack's vocabulary was not subtracted, and the terms
  // most likely to be written two ways are exactly the identifiers every member discusses. Keeping
  // the compound as well means an answer that quotes a full path still matches one that does.
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9_.$/-]+/u)) {
    const compound = raw.replace(/^[.\-/]+|[.\-/]+$/g, '');
    if (!compound) continue;
    for (const w of [compound, ...compound.split(/[./\-_]+/)]) {
      if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
    }
  }
  return out;
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * How much of each answer's vocabulary is shared with the others, before and after the shared
 * subject matter is removed.
 *
 * @param answers  [{id, text}]
 * @param packText the context pack + brief + question — everything every member was handed
 * @returns {{raw, distinctive, n, pairs, thin}}
 *   raw          mean pairwise Jaccard over all content words. Dominated by the pack's vocabulary
 *                and reported only so the correction is visible rather than taken on trust.
 *   distinctive  the same, over words NOT in the pack. **This is the one to read.**
 *   thin         true when the members said so little that the metric is noise — reported instead
 *                of a number, because a confident 0.9 from two 40-word answers is worse than
 *                "not enough text".
 */
export function reasoningOverlap(answers, packText = '') {
  const n = answers.length;
  if (n < 2) return { raw: null, distinctive: null, n, pairs: 0, thin: true };

  const pack = contentTokens(packText);
  const all = answers.map((a) => contentTokens(a.text));
  const own = all.map((s) => new Set([...s].filter((w) => !pack.has(w))));

  // Members with too little distinctive vocabulary are EXCLUDED from the comparison, not allowed to
  // void it.
  //
  // `thin` used to be `own.some(...)` — so one member answering "agreed, yes" discarded the metric
  // for everybody, including two long answers that were perfectly comparable to each other. One
  // terse member is common (a member that genuinely has little to add) and the information about
  // the others is exactly what a council is for. Which members were dropped is reported, because a
  // number computed over a subset must say so.
  const MIN_DISTINCTIVE = 25;
  const usable = [];
  const excluded = [];
  for (let i = 0; i < n; i++) {
    (own[i].size < MIN_DISTINCTIVE ? excluded : usable).push(i);
  }

  const rawPairs = [], ownPairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) rawPairs.push(jaccard(all[i], all[j]));
  }
  for (let a = 0; a < usable.length; a++) {
    for (let b = a + 1; b < usable.length; b++) ownPairs.push(jaccard(own[usable[a]], own[usable[b]]));
  }

  return {
    raw: mean(rawPairs),
    // Fewer than two usable members means there is no pair left to compare, which is the only
    // honest `null`.
    distinctive: ownPairs.length ? mean(ownPairs) : null,
    n, pairs: rawPairs.length,
    thin: ownPairs.length === 0,
    excluded: excluded.map((i) => answers[i].id),
    usableN: usable.length,
  };
}

/** Borrowed from council-review, unvalidated here. Printed as indicative, never as a verdict. */
export const OVERLAP_SUSPECT = 0.60;

/**
 * A reviewer's ranking block — the LAST `FINAL RANKING:` that starts a line, not the first anywhere.
 *
 * Probed 2026-07-28: a reviewer that quotes another response's ranking block — or a stage-1 answer
 * that happens to contain one — spoofed the parser, because the original pattern matched
 * `FINAL RANKING:` followed by "everything to the end" and took it from the FIRST occurrence. The
 * prompt says "finish with exactly this block and nothing after it", so the last line-anchored block
 * is the reviewer's own verdict.
 *
 * Lives here rather than in council.mjs so the tests can import the real function. They used to
 * reimplement it, which pins the intended behaviour but cannot notice council.mjs drifting away
 * from it — a test that agrees with itself.
 */
export function parseRanking(text) {
  const starts = [...String(text ?? '').matchAll(/^[^\S\n]*FINAL RANKING:/gim)];
  if (!starts.length) return '';
  return text.slice(starts.at(-1).index + starts.at(-1)[0].length);
}

/**
 * The labels one reviewer actually named, de-duplicated, in order.
 *
 * De-duplication matters: a reviewer that lists the same label twice would otherwise earn it two
 * Borda votes, and one member's sloppiness would outweigh another's care.
 */
export function rankedLabels(text) {
  const seen = new Set();
  const block = parseRanking(text);

  // ── two bugs, in opposite directions, and the fix has to avoid both ──
  //
  // The FIRST version split on newlines and took `.match()[1]` — one label per line. A reviewer that
  // wrote its ranking inline ("FINAL RANKING: 1. Response C 2. Response A") therefore contributed a
  // single label, failed `parsed.length < 2`, and was dropped from the tally as though it had refused
  // to rank. A formatting preference became a disenfranchisement.
  //
  // The SECOND version took every "Response X" anywhere in the block. That let prose vote: a reviewer
  // writing "1. Response C\n2. Response A — much weaker than Response C on the retry path" inserted a
  // second C at position 3. A silent wrong number, in the one place downstream consumers treat as
  // ground truth.
  //
  // So a label only counts when it is **ordinal-anchored**: preceded by a position marker — `1.`,
  // `2)`, `-`, `*`, `#` — with nothing but whitespace between. That is what a ranking looks like in
  // every format a model actually emits, inline or one-per-line, and it is not what prose looks like.
  const ordinal = /(?:^|[\n\r]|\s)\**\s*(?:\d{1,2}\s*\**\s*[.)\]:]|[-*•])\s*\**\s*Response\s+([A-Z])\b/gi;
  const found = [...block.matchAll(ordinal)].map((m) => m[1].toUpperCase());

  // Fallback: a reviewer that emitted no ordinals at all — "Response C, Response A, Response B" on one
  // line, say — still meant to rank them, and every label it named is part of that ranking.
  //
  // Permissive on purpose, and safe for a specific reason: **the prose problem only arises alongside
  // ordinals.** A reviewer justifying its choices writes "2. Response A — much weaker than Response C",
  // which has ordinals, so it takes the strict path and the prose mention is excluded. A block with no
  // ordinals is a bare list; there is no ranking structure for a stray mention to corrupt.
  const labels = found.length
    ? found
    : [...block.matchAll(/Response\s+([A-Z])\b/gi)].map((m) => m[1].toUpperCase());

  return labels.filter((L) => !seen.has(L) && seen.add(L));
}

/**
 * Borda count with self-votes removed.
 *
 * Measured on the first real run: 3 of 4 judges ranked their own unlabelled answer first — 75%
 * against a 20% chance rate, mean self-rank 1.5 against an unbiased 3.0. Anonymisation does not
 * prevent self-enhancement, because a model recognises its own writing. Dropping the self-vote and
 * re-ranking what remains costs nothing: every answer is still read by every other member.
 */
export function borda(reviews, ids) {
  const scores = Object.fromEntries(ids.map((i) => [i, 0]));
  // How many reviewers actually placed each answer. Needed because "scored 0" and "nobody ranked it"
  // are different facts and the old tally could not tell them apart.
  const ranked = Object.fromEntries(ids.map((i) => [i, 0]));
  let counted = 0, selfFirst = 0;
  const selfRanks = [];

  for (const r of reviews) {
    // A reviewer that named fewer than two responses has not ranked anything; counting it would
    // let a malformed answer nudge the tally.
    if (!r.parsed || r.parsed.length < 2) continue;
    counted++;
    const selfPos = r.parsed.indexOf(r.id);
    if (selfPos >= 0) { selfRanks.push(selfPos + 1); if (selfPos === 0) selfFirst++; }
    const others = r.parsed.filter((id) => id !== r.id);

    // NORMALISED, so every reviewer contributes the same total influence.
    //
    // Raw Borda gave a reviewer that ranked all four others 4+3+2+1 = 10 points to distribute and a
    // reviewer that named only two 2+1 = 3. A member whose answer was long enough that one reviewer
    // truncated its list therefore counted for a third as much as its careful colleague — the tally
    // silently weighted reviewers by how completely they followed the output format. Worse, a member
    // nobody named scored 0, indistinguishable from one everybody ranked last.
    //
    // Each reviewer spreads **exactly 1.0 in total** across the answers it ranked, evenly spaced
    // from best to worst. Unranked stays 0 and is reported separately in `ranked` below.
    //
    // The divisor is the sum of the raw Borda weights for a list of k, which is k(k−1)/2 — not
    // (k−1). Getting that wrong is how the first attempt at this fix still handed 1.5 to a reviewer
    // that ranked four and 1.0 to one that ranked three, which is the same unequal weighting in
    // smaller numbers. Caught by the test that asserts the totals match.
    // **Per-POSITION weight, fixed across ballots — not per-ballot total.**
    //
    // Equalising the total was the first fix, and it inverted the unfairness instead of removing it. A
    // reviewer that ranked 2 others spread 1.0 across two positions (0.5 each); one that ranked 4
    // spread it across four (up to 0.5 but as little as 0). So a truncated ballot gave its top pick up
    // to 2.5x the influence of a complete ballot's top pick — the same bias, pointing the other way.
    //
    // What has to be constant is the value of a POSITION, so first place is worth the same from every
    // reviewer. `n` is the number of answers being ranked, not the length of this ballot, so a short
    // ballot simply awards fewer points in total — which is correct: it expressed fewer preferences.
    const k = others.length;
    const n = ids.length - 1;                      // positions available to a reviewer, self excluded
    others.forEach((id, i) => {
      if (!(id in scores)) return;
      scores[id] += n <= 1 ? 1 : (n - 1 - i) / (n - 1);
      ranked[id] = (ranked[id] ?? 0) + 1;
    });
    void k;
  }

  // **With two answers the tally is empty, and it used to print a confident tie.**
  //
  // Self-votes are excluded, so each of two reviewers ranks exactly ONE other — every reviewer's
  // single award is 1.0 and both members score 1.0 regardless of who either of them preferred. The
  // number is not close; it is structurally constant. Reported as degenerate rather than printed as
  // a result, because a tie that cannot come out any other way looks exactly like a genuine tie.
  const degenerate = ids.length < 3;

  return {
    scores, ranked, counted, total: reviews.length, degenerate,
    selfFirst, selfN: selfRanks.length,
    selfMean: selfRanks.length ? mean(selfRanks) : null,
  };
}

/**
 * Correlation between a member's score and how much it wrote.
 *
 * Unstable at n=5 — observed 0.64 / −0.18 / 0.53 / 0.06 across four runs — which is why it is
 * printed with the run's n rather than used to adjust anything.
 */
export function verbosityR(scores, lengths) {
  const pairs = Object.keys(scores).map((id) => ({ s: scores[id], c: lengths[id] ?? 0 }));
  if (pairs.length < 2) return 0;
  const ms = mean(pairs.map((p) => p.s));
  const mc = mean(pairs.map((p) => p.c));
  const sd = (a, m) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0));
  const denom = sd(pairs.map((p) => p.s), ms) * sd(pairs.map((p) => p.c), mc);
  return denom ? pairs.reduce((s, p) => s + (p.s - ms) * (p.c - mc), 0) / denom : 0;
}

/**
 * Vendor mix, read from the roster rather than guessed from the id.
 *
 * **This was a bug, and a quiet one.** The family was inferred with
 * `id.startsWith('claude') ? 'Anthropic' : id === 'codex' ? 'OpenAI' : id === 'grok' ? 'xAI' :
 * 'Google'` — so every member of a custom `.council/members.json` that was not named exactly
 * `codex` or `grok` was reported as **Google**. A user who assembled a four-vendor roster would be
 * told one family held a majority when it did not, or reassured when it did. The one diagnostic
 * whose whole job is to warn about a lopsided council was itself lopsided by a fallback.
 *
 * Now `family` is declared per member and an undeclared one is counted as `unknown`, which shows
 * up as a gap to fill instead of a wrong answer.
 */
/**
 * True when one family holds HALF or more of the council.
 *
 * `>` was the shipped test, so exactly half was reported "ok" — and the default roster is Anthropic
 * 2 of 4 once grok is excluded as uncontained, which is exactly half. The diagnostic whose whole job
 * is warning about a lopsided council was silent on the configuration the package ships with.
 */
export function familyMajority(mix, n) {
  return n > 0 && Math.max(...Object.values(mix), 0) >= n / 2;
}

export function familyMix(members) {
  const out = {};
  for (const m of members) {
    const fam = m.family ?? 'unknown';
    out[fam] = (out[fam] ?? 0) + 1;
  }
  return out;
}

/**
 * A member's self-rated confidence, and what would change its mind.
 *
 * Why ask: unanimity at low confidence and unanimity at high confidence are the same tally and
 * very different evidence, and the old output could not tell them apart. Five members agreeing
 * while all five say "60%, and I would change my mind if I could see the caller" is a request for
 * more context, not a decision.
 *
 * Absence is a value. `null` means the member did not answer the question, which is worth showing
 * — it is the one part of the format that is trivially easy to comply with.
 */
export function parseConfidence(text) {
  const conf = labelled(text, 'CONFIDENCE');
  const n = conf === null ? null : parseInt(conf.match(/(\d{1,3})/)?.[1] ?? '', 10);
  const mind = labelled(text, 'WOULD CHANGE MY MIND IF') ?? labelled(text, 'CHANGE MY MIND IF');
  return {
    confidence: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null,
    changeMind: mind ? mind.slice(0, 400) : null,
  };
}

/**
 * ── The value after `LABEL:` on a line, whatever markdown the model wrapped it in ──────────
 *
 * **This was losing data silently, and a lot of it.** The patterns were anchored as
 * `/^[^\S\n]*CONFIDENCE:/` — a line start, optional whitespace, then the bare label. Models do not
 * write bare labels. They write what looks right in markdown, and every one of these shapes failed:
 *
 *     **CONFIDENCE:** 80          bold label
 *     **CONFIDENCE: 80**          bold whole line
 *     ## CONFIDENCE: 80           heading
 *     - CONFIDENCE: 80            list item
 *     > CONFIDENCE: 80            quote
 *     **Confidence:** 80          title case
 *     | CONFIDENCE | 80 |         table row
 *
 * Eleven of fifteen realistic shapes returned `null`. And the failure is the bad kind: the run then
 * reported *"did not state a confidence"* about a member that stated one clearly — so across six
 * rounds of grading, judges shown as `—` in the confidence column had most likely complied in bold.
 * A parser that only accepts one formatting choice is measuring formatting, not confidence.
 *
 * So the line is stripped of leading decoration and inline emphasis before matching, and the LAST
 * match still wins — a member quoting someone else's `CONFIDENCE:` must not outrank its own closing
 * line, which is the same reasoning `parseRanking` uses.
 */
export function labelled(text, label) {
  const wanted = label.toLowerCase();
  let found = null;
  for (const raw of String(text ?? '').split('\n')) {
    // Leading markdown: heading hashes, list bullets, blockquotes, table pipes, emphasis.
    const line = raw.replace(/^[\s>#*\-+|]*/, '').replace(/\*\*|__|`/g, '').trim();
    const at = line.toLowerCase().indexOf(`${wanted}:`);
    if (at !== 0) {
      // A table row puts the label and value in separate cells: `| CONFIDENCE | 80 |`.
      const cells = raw.split('|').map((c) => c.replace(/\*\*|__|`/g, '').trim()).filter(Boolean);
      if (cells.length >= 2 && cells[0].toLowerCase() === wanted) found = cells.slice(1).join(' ').trim();
      continue;
    }
    const value = line.slice(wanted.length + 1).replace(/\*+$/, '').trim();
    if (value) found = value;
  }
  return found;
}

/**
 * Scores from a rubric run: `DIMENSION | n/10 | why`.
 *
 * **Aggregated by median, not mean.** With five judges a single outlier — one member that scores
 * everything 3 because it read the rubric as a checklist, or one that scores everything 9 because
 * it is agreeable — moves a mean by more than a whole point and moves the median by nothing. The
 * spread is reported alongside, because five judges landing on 4,4,9,9,9 is a median of 9 that
 * nobody should act on, and it must not look like five judges landing on 8,9,9,9,9.
 */
export function aggregateScores(perJudge) {
  const dims = new Map();
  for (const judge of perJudge) {
    for (const [dim, score] of Object.entries(judge.scores ?? {})) {
      if (!Number.isFinite(score)) continue;
      if (!dims.has(dim)) dims.set(dim, []);
      dims.get(dim).push(score);
    }
  }
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const out = {};
  for (const [dim, vals] of dims) {
    out[dim] = { median: median(vals), min: Math.min(...vals), max: Math.max(...vals), n: vals.length, values: vals };
  }
  const overallVals = perJudge.map((j) => j.overall).filter(Number.isFinite);
  return {
    dimensions: out,
    overall: overallVals.length
      ? { median: median(overallVals), min: Math.min(...overallVals), max: Math.max(...overallVals), n: overallVals.length, values: overallVals }
      : null,
  };
}

/**
 * Pull `SCORE: <dimension> | <n>/10 | <why>` lines and a final `OVERALL: <n>/10` out of one
 * judge's answer.
 *
 * Tolerant of the shapes models actually emit — a bare `8/10`, spaces around the slash, the number
 * wrapped in markdown bold, a table row — and anchored to line starts so a score quoted from
 * another judge's answer cannot be harvested as this judge's own. Same reasoning as `parseRanking`
 * taking the LAST block.
 */
export function parseRubric(text) {
  const s = String(text ?? '');
  const scores = {};
  const notes = {};
  for (const raw of s.split('\n')) {
    // Same decoration stripping as `labelled`: a judge that writes its scores as a bold list, a
    // heading or a table row means the same thing as one that writes them plainly, and a parser that
    // only accepts the plain form throws away most of the grading it asked for.
    const line = raw.replace(/^[\s>#*\-+|]*/, '').replace(/\*\*|__|`/g, '').trim();
    const m = line.match(/^SCORE:\s*([^|]+?)\s*[|:]\s*(\d{1,2}(?:\.\d)?)\s*\/\s*10\s*(?:[|:]\s*(.*))?$/i);
    if (!m) continue;
    const dim = m[1].trim().toLowerCase();
    const val = parseFloat(m[2]);
    if (!dim || !Number.isFinite(val)) continue;
    scores[dim] = Math.max(0, Math.min(10, val));
    if (m[3]) notes[dim] = m[3].trim().replace(/\|+$/, '').trim().slice(0, 300);
  }
  const o = labelled(s, 'OVERALL');
  const n = o ? parseFloat(o.match(/(\d{1,2}(?:\.\d)?)\s*\/\s*10/)?.[1] ?? o.match(/(\d{1,2}(?:\.\d)?)/)?.[1] ?? '') : NaN;
  return { scores, notes, overall: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null };
}

/**
 * Every occurrence of `LABEL:` in a document, decoration-tolerant.
 *
 * `labelled` returns the LAST match, which is right for a closing line a member states once. Findings
 * are the opposite case: a judge emits many, and losing the ones it happened to bullet or bold means
 * losing most of the review.
 */
export function labelledAll(text, label) {
  const wanted = label.toLowerCase();
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^[\s>#*\-+|]*/, '').replace(/\*\*|__|`/g, '').trim();
    if (line.toLowerCase().indexOf(`${wanted}:`) !== 0) continue;
    const value = line.slice(wanted.length + 1).replace(/\*+$/, '').trim();
    if (value) out.push(value);
  }
  return out;
}

// ── a seeded shuffle, so a run is reproducible but position bias is not shared ────
//
// **This was numerically broken, and it broke the feature the README calls "better than the
// original".** The seed was a 48-bit integer and the step was written in floating point:
//
//     h = (h * 1103515245 + 12345) % 2147483648
//
// 2^48 × 1103515245 is about 2^78, far past the 2^53 where a double stops representing integers
// exactly, so the low bits — the only ones `% (i + 1)` reads — were rounded away. Measured over
// 20,000 seeds:
//
//     h % 4 distribution:            [19922, 78, 0, 0]   (should be ~5000 each)
//     distinct permutations of 5:    23 of 120
//
// So `j` was almost always 0 and reviewers were seeing a handful of near-identical orderings. The
// whole point of the per-reviewer permutation is that position bias does not point the same way for
// everyone; with 23 reachable orderings out of 120, it largely did.
//
// Fixed by doing the arithmetic in 32 bits, where it is exact: `Math.imul` multiplies as int32 and
// `>>> 0` keeps it unsigned. `% (i + 1)` on the LOW bits of an LCG is still the weak end of the
// generator, so the high bits are used instead — the classic LCG caveat, and the reason the naive
// version would have been mediocre even without the overflow.
export const seedNum = (s) => parseInt(crypto.createHash('sha256').update(s).digest('hex').slice(0, 8), 16) >>> 0;

export function shuffled(arr, seedStr) {
  let h = seedNum(seedStr);
  const next = () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h >>> 8;                 // the high 24 bits; the low bits of an LCG are the weak ones
  };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

