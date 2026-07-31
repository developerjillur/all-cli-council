#!/usr/bin/env node
// Is this package installable, or only runnable from a clone?
//
// ── why this exists ─────────────────────────────────────────────────────────
//
// The other two suites test the council's BEHAVIOUR — 573 assertions on containment, parsing,
// aggregation, and one that SIGKILLs a session to prove a detached run survives it. None of
// them notices if the package is shaped wrongly, and a plugin that behaves perfectly from a
// clone and breaks on `/plugin install` is broken for everybody who did not clone it.
//
// The sibling project this council is vendored into caught three separate regressions of
// exactly this kind in one day, none of which any behaviour test could see:
//
//   · a new file was never `git add`ed, so it existed locally and in no clone
//   · two `bin/` wrappers lost their executable bit to a `git reset`
//   · a README count said 7 where the filesystem said 11
//
// Every one is a one-line check and every one shipped without it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });

console.log('\n▸ the package, as something somebody installs');

// ── 1 · the manifest ────────────────────────────────────────────────────────
const manifest = path.join(ROOT, '.claude-plugin', 'plugin.json');
check('.claude-plugin/plugin.json exists', fs.existsSync(manifest));
let plugin = {};
try { plugin = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (e) {
  check('...and is valid JSON', false, e.message);
}
for (const key of ['name', 'version', 'description', 'license']) {
  check(`...declares ${key}`, typeof plugin[key] === 'string' && plugin[key].length > 0);
}
check('...and the version is semver', /^\d+\.\d+\.\d+$/.test(plugin.version ?? ''), plugin.version);

const market = path.join(ROOT, '.claude-plugin', 'marketplace.json');
check('.claude-plugin/marketplace.json exists', fs.existsSync(market));
let mk = {};
try { mk = JSON.parse(fs.readFileSync(market, 'utf8')); } catch (e) {
  check('...and is valid JSON', false, e.message);
}
// The marketplace entry must NAME the plugin the manifest declares, or `/plugin install
// <plugin>@<marketplace>` resolves to nothing and the error names neither file.
const entry = (mk.plugins ?? []).find((p) => p.name === plugin.name);
check('...and its plugins[] names the plugin this manifest declares',
  !!entry, `marketplace lists ${(mk.plugins ?? []).map((p) => p.name).join(', ') || 'nothing'}, manifest says ${plugin.name}`);
check('...with a source Claude Code can resolve', !!entry?.source, entry?.source);

// ── 2 · everything shipped is TRACKED ───────────────────────────────────────
//
// A file that exists only in the author's working tree is absent from every clone and every
// install. This is the check that catches a forgotten `git add`, and it is the one that fired
// in the sibling project.
{
  const tracked = new Set(git('ls-files').split('\n').filter(Boolean));
  const shipped = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name) || e.name.startsWith('._')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      shipped.push(path.relative(ROOT, p));
    }
  };
  for (const dir of ['scripts', 'commands', 'skills', 'bin']) {
    if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  }
  const untracked = shipped.filter((f) => !tracked.has(f));
  check(`every shipped file is tracked by git (${shipped.length} checked)`,
    untracked.length === 0, `${untracked.join(', ')} — absent from a clone and from an install`);
}

// ── 3 · the bin wrappers ────────────────────────────────────────────────────
//
// A wrapper that is not executable IN THE INDEX is not executable after a clone, whatever the
// local filesystem says. On a filesystem without permission bits — exFAT, and Windows without
// developer mode — the local mode is meaningless and only the index is real.
{
  const binDir = path.join(ROOT, 'bin');
  if (fs.existsSync(binDir)) {
    const wrappers = fs.readdirSync(binDir).filter((f) => !f.startsWith('.'));
    check(`bin/ ships ${wrappers.length} wrapper(s)`, wrappers.length > 0);
    const modes = git('ls-files', '-s', 'bin').split('\n').filter(Boolean)
      .map((l) => l.split(/\s+/)).map(([mode, , , p]) => ({ mode, p }));
    const notExec = modes.filter((m) => m.mode !== '100755');
    check('every bin/ wrapper is executable in the git index',
      notExec.length === 0, notExec.map((m) => `${m.p} ${m.mode}`).join(', '));

    // And each one must point at a script that is actually there.
    for (const w of wrappers) {
      const body = fs.readFileSync(path.join(binDir, w), 'utf8');
      const target = body.match(/scripts\/([\w.-]+\.mjs)/)?.[1];
      check(`  bin/${w} → scripts/${target ?? '?'} exists`,
        !!target && fs.existsSync(path.join(ROOT, 'scripts', target)));
    }
  }
}

// ── 4 · commands and skills resolve ─────────────────────────────────────────
//
// Claude Code discovers these by convention. A command whose frontmatter is missing is a
// command that does not appear, with no error anywhere.
for (const [dir, what] of [['commands', 'command'], ['skills', 'skill']]) {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) continue;
  const files = dir === 'commands'
    ? fs.readdirSync(d).filter((f) => f.endsWith('.md'))
    : fs.readdirSync(d).filter((s) => fs.existsSync(path.join(d, s, 'SKILL.md')))
      .map((s) => path.join(s, 'SKILL.md'));
  check(`${dir}/ ships ${files.length} ${what}(s)`, files.length > 0);
  for (const f of files) {
    const body = fs.readFileSync(path.join(d, f), 'utf8');
    check(`  ${dir}/${f} has name + description frontmatter`,
      /^---[\s\S]*?\bdescription:/m.test(body)
      && (dir === 'commands' || /^---[\s\S]*?\bname:/m.test(body)));
  }
}

// ── 5 · every script the docs promise is really there ───────────────────────
//
// The README, the skill and both commands all cite script paths. A citation into a file that
// does not exist is the failure this project's sibling built a whole tool to catch.
{
  const docs = ['README.md', 'skills/council/SKILL.md', 'commands/council.md', 'commands/council-custom.md']
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  const missing = [];
  for (const doc of docs) {
    const body = fs.readFileSync(path.join(ROOT, doc), 'utf8');
    for (const m of body.matchAll(/scripts\/([\w.-]+\.mjs)/g)) {
      if (!fs.existsSync(path.join(ROOT, 'scripts', m[1]))) missing.push(`${doc} → scripts/${m[1]}`);
    }
  }
  check(`every scripts/*.mjs the docs cite exists (${docs.length} docs read)`,
    missing.length === 0, [...new Set(missing)].join('; '));
}

// ── 6 · every script parses ─────────────────────────────────────────────────
//
// Cheap, and it catches the one failure mode that makes a plugin dead on arrival: a syntax
// error in a file the test suite happens not to import.
{
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => f.endsWith('.mjs'));
  const broken = scripts.filter((f) => {
    try {
      execFileSync('node', ['--check', path.join(ROOT, 'scripts', f)], { stdio: 'ignore' });
      return false;
    } catch { return true; }
  });
  check(`all ${scripts.length} scripts parse`, broken.length === 0, broken.join(', '));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log('  A plugin that runs from a clone and breaks on install is broken for everybody\n'
    + '  who did not clone it.\n');
  process.exit(1);
}
console.log('  Installable, not merely runnable.\n');
