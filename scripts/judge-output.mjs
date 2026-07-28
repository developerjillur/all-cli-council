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
  /\byou'?ve (hit|reached) your .{0,20}\blimit\b/i,
  /\b(insufficient (credit|quota)|billing[_ ]not[_ ]active|payment required)\b/i,
  /\bauthentication (failed|error)\b/i,
  /\b(not logged in|please (log ?in|sign ?in))\b/i,
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
export const FIRST_LINE_ONLY = [
  /\b429\b/,
  /\btoo many requests\b/i,
  /\bunauthorized\b/i,
  /^\s*error[: ]/i,
];

/** Below this, it is a status line rather than a considered answer. */
export const MIN_ANSWER_CHARS = 24;

/** Only the first N characters are examined for the unambiguous patterns. */
const HEAD = 400;

/**
 * @returns {[boolean, string]} `[isAnswer, textOrReason]`
 */
export function judgeOutput(out, err, code) {
  const text = (out || '').trim();
  if (code !== 0) return [false, text || (err || '').trim() || `exit ${code}`];
  if (!text) return [false, (err || '').trim() || 'empty output'];
  if (text.length < MIN_ANSWER_CHARS) return [false, `output too short to be an answer: "${text}"`];

  const head = text.slice(0, HEAD);
  const firstLine = text.split('\n')[0];
  const refusal = UNAMBIGUOUS.some((re) => re.test(head))
    || (firstLine.length <= STATUS_LINE_MAX && FIRST_LINE_ONLY.some((re) => re.test(firstLine)));
  if (refusal) {
    return [false, `refused: the CLI reported a limit or auth failure — "${firstLine.slice(0, 90)}"`];
  }
  return [true, text];
}
