// The command line, parsed once, against a declared schema — fail closed.
//
// ── Why this is a module and not three helper closures ────────────────────────────────────
//
// The old parsing was three one-liners over `process.argv`:
//
//     const has  = (n) => argv.includes(`--${n}`) || argv.some((a) => a.startsWith(`--${n}=`));
//     const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
//     const ctxFiles = [];  // filled by scanning for `--context` and taking following tokens
//
// Each is reasonable alone. Together they had no idea what the flags WERE, so every disagreement
// between "how this flag is spelled" and "how it is read" became a silent wrong behaviour. Four
// separate defects, all the same root, and three of four judges named the same fix:
//
//   1. **`--detach=1` was a fork bomb.** `has('detach')` matched the `=` form, and the child argv was
//      built with `argv.filter((a) => a !== '--detach')` — which removes the bare token only. So the
//      child re-detached, and its child re-detached, without end. **The council never ran.**
//   2. **`--context=a.js` silently gave ZERO context.** The `=` form passed the known-flag check and
//      the collector only understood the space form, so the run proceeded with an empty pack — which
//      this package's own README calls "five informed guesses".
//   3. **`--timeout=abc` silently became 15 minutes**, because `Number('abc')` is NaN and NaN failed
//      the `> 0` test into the default.
//   4. **A typo'd `--members=codx` said "install one"** rather than "there is no such member".
//
// So the flags are declared, every token must be consumed or refused, and both spellings are handled
// for the flags that take values. A boolean given a value is an error rather than a truthy string —
// that one rule is what makes the fork bomb unreachable rather than merely fixed.

/**
 * The schema. `type` decides how a token is read and what an illegal form means.
 *
 *   bool            present or absent. **A value is an ERROR** — see the fork bomb above.
 *   value           requires `=`. The space form is refused, because `--members codex` would
 *                   otherwise swallow "codex" out of the question.
 *   number          as `value`, plus a range. A non-number is an error, never a silent default.
 *   optional-value  bare is meaningful, `=path` overrides. Only `--events` behaves this way.
 *   list            repeatable, accepts `--context a.js b.js` AND `--context=a.js`.
 */
export const FLAGS = {
  context: { type: 'list' },
  card: { type: 'list', into: 'context' },
  members: { type: 'value' },
  timeout: { type: 'number', min: 1, max: 120 },
  events: { type: 'optional-value' },
  'stage1-only': { type: 'bool' },
  revise: { type: 'bool' },
  lenses: { type: 'bool' },
  rubric: { type: 'bool' },
  'peer-review': { type: 'bool' },
  'json-events': { type: 'bool' },
  'no-live': { type: 'bool' },
  preflight: { type: 'bool' },
  'verify-delivery': { type: 'bool' },
  'allow-uncontained': { type: 'bool' },
  'local-roster': { type: 'bool' },
  detach: { type: 'bool' },
};

/**
 * Parse `argv`. Returns `{ok: true, flags, list, question, questionTokens}` or
 * `{ok: false, errors: [...], hint?}`.
 *
 * **Never throws and never guesses.** Every problem is a returned message naming the token, because
 * the caller's job is to print them and exit — and because a parser that guesses is how all four of
 * the defects above happened.
 */
export function parseArgs(argv) {
  const flags = Object.create(null);
  const list = Object.create(null);
  const questionTokens = [];
  const errors = [];
  let hint = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];

    if (!tok.startsWith('--')) { questionTokens.push(tok); continue; }

    // `--` on its own: everything after it is the question, verbatim. Standard, and it gives a user a
    // way to ask a question that legitimately contains a flag-shaped word.
    if (tok === '--') { questionTokens.push(...argv.slice(i + 1)); break; }

    const eq = tok.indexOf('=');
    const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq));
    const inlineValue = eq === -1 ? null : tok.slice(eq + 1);
    const spec = FLAGS[name];

    if (!spec) {
      errors.push(`Unknown option: ${tok}`);
      hint = 'unknown';
      continue;
    }

    const key = spec.into ?? name;

    switch (spec.type) {
      case 'bool':
        // **The rule that makes `--detach=1` impossible rather than merely handled.** A boolean with a
        // value is a misunderstanding, and silently treating the string as truthy is what turned one
        // into an unbounded respawn chain.
        if (inlineValue !== null) {
          errors.push(`--${name} is a switch and takes no value — you wrote ${tok}. Use --${name} on its own.`);
          continue;
        }
        flags[key] = true;
        break;

      case 'optional-value':
        flags[key] = inlineValue === null ? true : inlineValue;
        if (inlineValue === '') errors.push(`--${name}= was given an empty value.`);
        break;

      case 'value':
      case 'number': {
        if (inlineValue === null) {
          // The space form is refused rather than supported: `--members codex` would take "codex" out
          // of the question, changing both the roster and the question at once.
          const next = argv[i + 1];
          errors.push(`--${name} needs its value attached with "=": --${name}=${next && !next.startsWith('--') ? next : '<value>'}`);
          hint = 'space-form';
          continue;
        }
        if (inlineValue === '') { errors.push(`--${name}= was given an empty value.`); continue; }
        if (spec.type === 'number') {
          const n = Number(inlineValue);
          if (!Number.isFinite(n)) {
            // Silently defaulting is how `--timeout=abc` became a 15-minute budget nobody asked for.
            errors.push(`--${name}=${inlineValue} is not a number.`);
            continue;
          }
          const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(n)));
          if (clamped !== n) {
            flags[`${key}Clamped`] = { from: inlineValue, to: clamped, min: spec.min, max: spec.max };
          }
          flags[key] = clamped;
        } else {
          flags[key] = inlineValue;
        }
        break;
      }

      case 'list': {
        (list[key] ??= []);
        if (inlineValue !== null) {
          if (inlineValue === '') { errors.push(`--${name}= was given an empty value.`); break; }
          // `--context=a.js` — the form that used to be accepted and then thrown away.
          list[key].push(inlineValue);
        } else {
          // `--context a.js b.js` — consume following tokens until the next flag.
          let taken = 0;
          while (argv[i + 1] && !argv[i + 1].startsWith('--')) { list[key].push(argv[++i]); taken++; }
          if (!taken) errors.push(`--${name} was given no files.`);
        }
        break;
      }

      default:
        errors.push(`Internal: --${name} has an unknown spec type "${spec.type}".`);
    }
  }

  if (errors.length) return { ok: false, errors, hint };

  return {
    ok: true,
    flags,
    list,
    questionTokens,
    question: questionTokens.join(' ').trim(),
  };
}

/**
 * Rebuild an argv WITHOUT the named switches — correctly for both spellings.
 *
 * `--detach` needs this to hand its own arguments to the child, and doing it by hand
 * (`argv.filter((a) => a !== '--detach')`) is what created the fork bomb: it removed the bare token
 * and left `--detach=1` in place.
 */
export function without(argv, names) {
  const drop = new Set(names);
  return argv.filter((a) => {
    if (!a.startsWith('--')) return true;
    const eq = a.indexOf('=');
    return !drop.has(eq === -1 ? a.slice(2) : a.slice(2, eq));
  });
}
