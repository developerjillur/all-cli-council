// One boundary for every file this package writes.
//
// ── Why this exists rather than a third patch ──────────────────────────────────────────────
//
// A previous round added a symlink refusal for the run's `.md` and `.json`. **Three of four judges
// independently found the same hole in it**, and the agreement is the point: the guard was written
// per-call-site, and the `--events` stream is a different call site — opened *before* the guard
// runs, written to for the whole run, and never checked at all. A defence applied at two of three
// sites is not a defence; it is a list.
//
// It was also too shallow where it did run. `fs.lstat` on the leaf answers "is this file a symlink",
// not "does this path resolve inside the workspace". A repo shipping `.council/runs/` — or
// `.council/` — as a symlink to `/etc` redirected all three files while every leaf lstat came back
// clean, because the leaves did not exist yet.
//
// So: one function, and every write goes through it. The check is containment, not pattern-matching —
// the same reasoning `context.mjs` uses for reads, and for the same reason. **A denylist of shapes
// cannot be completed; a resolved path either is or is not inside the tree.**
//
// The paths involved are attractive targets specifically because they are predictable. A run file is
// `.council/runs/<slug>.md` where the slug comes from the question, and the question is often chosen
// by the skill rather than typed by the user.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the deepest existing ancestor of `p`.
 *
 * `realpathSync` throws on a path that does not exist yet, which is the normal case for a file about
 * to be created — so walk up until something resolves, and check THAT. This is what catches a
 * symlinked parent directory: `.council/runs/x.md` does not exist, `.council/runs` does, and it
 * points at `/etc`.
 */
function realExistingAncestor(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { return { real: fs.realpathSync(cur), checked: cur }; } catch { /* keep walking up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return { real: cur, checked: cur };   // hit the filesystem root
    cur = parent;
  }
}

/**
 * Is `target` a safe place for this package to write, given a workspace `root`?
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function checkWritable(target, root) {
  const abs = path.resolve(target);

  // A symlink AT the destination: refuse rather than follow. Writing through it would put the
  // content wherever the link points, which is the one thing the caller did not ask for.
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) {
      let points = '(unresolvable)';
      try { points = fs.realpathSync(abs); } catch { /* dangling */ }
      return { ok: false, reason: `${path.relative(root, abs)} is a symlink (→ ${points}). Refusing to `
        + `write through it — a run file is a predictable path, and following a link there lets whoever `
        + `created it choose the destination. Delete or rename it and re-run.` };
    }
  } catch { /* does not exist yet — the normal case */ }

  // And the resolved DIRECTORY must be inside the workspace. This is the half the leaf check missed.
  const rootReal = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  const { real, checked } = realExistingAncestor(path.dirname(abs));
  const inside = real === rootReal || real.startsWith(rootReal + path.sep);
  if (!inside) {
    return { ok: false, reason: `${path.relative(root, abs)} would be written outside the workspace: `
      + `\`${path.relative(root, checked) || checked}\` resolves to ${real}. Refusing — a symlinked `
      + `parent directory redirects every file in it, and the leaf looks innocent.` };
  }
  return { ok: true, path: abs };
}

/**
 * Write, or return the reason it was refused. **Never throws for a policy reason**, so a caller can
 * report a refusal the same way it reports any other result.
 */
export function safeWrite(target, contents, root) {
  const check = checkWritable(target, root);
  if (!check.ok) return check;
  try {
    fs.mkdirSync(path.dirname(check.path), { recursive: true });
    fs.writeFileSync(check.path, contents);
    return { ok: true, path: check.path };
  } catch (e) {
    return { ok: false, reason: `could not write ${path.relative(root, check.path)}: ${e.message}` };
  }
}
