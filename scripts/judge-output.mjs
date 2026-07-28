// Is this output an answer, or a CLI telling you it cannot answer?
//
// Split out of council.mjs so it can be tested without running a council. That is not tidiness:
// this is the function that decides whether a quota message gets ranked as an opinion, and it
// was wrong until it was probed.
//
// Probed 2026-07-28. A member printing "You've hit your usage limit · resets Jul 29" and
// **exiting 0** was accepted as a valid answer, sent into the anonymised peer review, ranked
// against real answers, and counted in the Borda tally. **Exit code is not enough** — a CLI
// that successfully reports a quota failure has not failed to run.

/**
 * Anchored near the START of the output, deliberately.
 *
 * The cost of a false positive here is discarding a good answer silently, which is worse than
 * the thing being guarded against. A real answer that happens to *discuss* rate limiting must
 * survive; a CLI that opens by announcing one must not.
 */
/**
 * Two tiers, because one list produced a false positive immediately.
 *
 * A bare `\b429\b` refused this real answer: *"…a 429 from the provider should surface as a
 * filler rather than silence."* Discarding that silently is worse than accepting a quota
 * message, so the terse signals are only trusted **on the first line**, where a CLI puts its
 * status and an essay does not.
 */
export const UNAMBIGUOUS = [
  /\b(usage|rate|quota) limit (reached|exceeded|hit)\b/i,
  /\byou(?:'?ve| have| are) (?:hit|reached|out of) .{0,24}\blimit\b/i,
  /\b(usage|rate|quota|token) limit\b.{0,40}\b(reset|resets|try again)\b/i,
  /\b(insufficient (credit|quota)|billing[_ ]not[_ ]active|payment required)\b/i,
  // Anchored to a LINE START, not "anywhere in the first 400 characters". A real answer that
  // discusses auth — "authentication failed should surface as a filler rather than silence" — was
  // being discarded, which is the same false positive the terse tier exists to avoid and the same
  // cost this file's header calls worse than the failure it guards against. A CLI announces an auth
  // failure at the start of a line; an essay mentions it mid-sentence.
  /^[^\S\n]*\S{0,20}\bauthentication (failed|error)\b/im,
  /^[^\S\n]*\S{0,20}\b(not logged in|please (log ?in|sign ?in))\b/im,
  /\bmodel\b.{0,40}\b(not found|unavailable|not supported)\b/i,
];

/**
 * Terse enough to appear inside a real answer, so these only count on a **short first line**.
 *
 * Line position alone was not enough: the answer that first exposed this is a single long line
 * mentioning a 429, so "first line" was the whole essay. The signal that actually separates
 * them is **length** — a CLI status message is terse by nature, an answer is not.
 */
const STATUS_LINE_MAX = 100;

/**
 * A line that is a machine's STATUS, rather than the opening of a sentence.
 *
 * Anchoring these to the start of the line was not enough, and it is worth being precise about why.
 * `429 Too Many Requests` and `429 responses should be retried off the hot path in this design.` both
 * begin with the token; both are under `STATUS_LINE_MAX`. Position cannot separate them and neither
 * can vocabulary — the whole difficulty is that the words are identical.
 *
 * **Sentence structure can.** A status message is a label: a handful of words, no terminal
 * punctuation. An answer is prose: it runs on, and it ends with a full stop. So the terse patterns
 * only apply to a line that looks like a label, and every real answer tested against this — including
 * the ones that open with `429`, `Unauthorized` or `Error` — is released.
 */
function looksLikeStatusLine(line) {
  const t = line.trim();
  if (!t || t.length > STATUS_LINE_MAX) return false;
  if (/[.?!]$/.test(t)) return false;              // prose ends; a label does not
  return t.split(/\s+/).length <= 8;               // a label is short in WORDS, not only in characters
}

export const FIRST_LINE_ONLY = [
  // Anchored to the START of the line as well, because a 429 mentioned mid-sentence is discussion.
  // These three were left unanchored when `error:` and the 429-in-prose case were fixed — the same bug
  // class, closed for one instance and left open for the others.
  /^\s*(HTTP\s*)?429\b/,
  /^\s*(error|warn)?[:\s]*\b429\b/i,
  /^\s*\btoo many requests\b/i,
  /^\s*\bunauthorized\b/i,
  // WAS A FALSE POSITIVE, and it discarded real answers silently — the exact cost this file's own
  // header warns is worse than the thing being guarded against.
  //
  // The pattern was `/^\s*error[: ]/i`, which matches any first line beginning "Error " — including
  //   "Error handling here is the weak point of the whole design, and it shows up in the retry path."
  // a 99-character opener, under STATUS_LINE_MAX, from a member answering the question well. It was
  // thrown away with no trace but a one-line reason nobody reads.
  //
  // A CLI announcing an error uses punctuation or a code: `error:`, `error -`, `Error [E1234]`. An
  // English sentence starting with the word "error" continues with a noun. Requiring the delimiter
  // keeps the status messages and releases the prose.
  /^\s*error\s*[:\-–—[(#]/i,
  /^\s*(fatal|panic)\b/i,
];

/** Below this, it is a status line rather than a considered answer. */
export const MIN_ANSWER_CHARS = 24;

/** Only the first N characters of stderr are examined for the unambiguous patterns. */
const HEAD = 400;

/**
 * @returns {[boolean, string]} `[isAnswer, textOrReason]`
 */
export function judgeOutput(out, err, code) {
  const text = (out || '').trim();
  if (code !== 0) return [false, text || (err || '').trim() || `exit ${code}`];
  if (!text) return [false, (err || '').trim() || 'empty output'];
  if (text.length < MIN_ANSWER_CHARS) return [false, `output too short to be an answer: "${text}"`];

  // **Both tiers are now gated the same way: a SHORT LINE near the top.**
  //
  // The unambiguous tier used to scan the first 400 characters of body text with no anchoring at all,
  // and that is a false positive waiting for a specific kind of answer — the kind this package invites.
  // Measured: this real answer was silently discarded —
  //
  //   "The comment in judge-output.mjs says a member printing 'You have hit your usage limit' and
  //    exiting 0 was ranked as an opinion. That guard is the right idea but it scans unanchored body
  //    text, which is a false-positive risk."
  //
  // — and **the context pack ships the trigger strings**, because they are quoted in this file's own
  // comments and in the tests. So a member reviewing the quota guard was liable to be thrown out by
  // the quota guard, and the run would report it as a CLI failure. Discarding a good answer silently
  // is the cost this file's header calls worse than the thing being guarded against, and here it was
  // aimed squarely at the most useful answers available.
  //
  // A CLI's status message is terse and occupies its own line. An essay that MENTIONS a quota writes
  // it inside a sentence. Length and line position separate them; vocabulary never could.
  const lines = text.split('\n');
  const topLines = lines.slice(0, 3).filter((l) => l.trim());
  const statusish = topLines.filter((l) => l.trim().length <= STATUS_LINE_MAX);
  const firstLine = lines[0];
  const refusal = statusish.some((l) => UNAMBIGUOUS.some((re) => re.test(l)))
    || (looksLikeStatusLine(firstLine) && FIRST_LINE_ONLY.some((re) => re.test(firstLine)));
  if (refusal) {
    // The line that actually MATCHED, not line 1. A CLI printing a banner first — "codex v1.2" —
    // produced `refused: ... — "codex v1.2"`, which names the wrong line and reads as a bug in the
    // guard rather than a quota message. The reason string is the only trace of why an answer was
    // dropped, so it has to point at the evidence.
    const matched = statusish.find((l) => UNAMBIGUOUS.some((re) => re.test(l))) ?? firstLine;
    return [false, `refused: the CLI reported a limit or auth failure — "${matched.trim().slice(0, 90)}"`];
  }

  // WAS OPEN: stderr was consulted ONLY when stdout was empty. A CLI that prints a partial answer to
  // stdout and its failure to stderr therefore passed — "here is a partial thought about the design"
  // plus "You have hit your usage limit" was ranked as a considered opinion. Only the UNAMBIGUOUS
  // tier is applied here: stderr routinely carries progress chatter, and the terse signals would
  // produce exactly the false positives this file's header warns are worse than the failure.
  const errHead = (err || '').slice(0, HEAD);
  if (errHead && UNAMBIGUOUS.some((re) => re.test(errHead))) {
    return [false, `refused: the CLI reported a limit or auth failure on stderr — `
      + `"${errHead.split('\n').find((l) => l.trim())?.slice(0, 90) ?? ''}"`];
  }
  return [true, text];
}
