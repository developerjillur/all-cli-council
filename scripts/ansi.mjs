// The two escape sequences the live renderer needs, and nothing else.
//
// Built from `String.fromCharCode(27)` rather than written as a literal 0x1b byte in the source.
// A raw control character survives git and survives node, but not reliably an editor, a linter, a
// review diff or a copy-paste — and when one is stripped the result is not an error, it is a
// renderer that prints `[3A` at the user instead of moving the cursor. This way there is no
// invisible character in the repo at all.

const CSI = `${String.fromCharCode(27)}[`;

/** Move the cursor up `n` lines. */
export const up = (n) => `${CSI}${n}A`;

/** Erase from the cursor to the end of the screen. */
export const clearBelow = `${CSI}0J`;
