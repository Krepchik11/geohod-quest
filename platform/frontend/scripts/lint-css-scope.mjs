/**
 * Scoping CSS per route makes one silent failure possible: a route renders a
 * class whose stylesheet it does not load, and draws unstyled with nothing
 * failing. This asserts the opposite for every route.
 *
 * Ownership is read from the imports, and "what a route renders" follows the
 * import graph — not the directory tree, since `app/components/` is rendered by
 * routes that do not contain it.
 *
 * Run: npm run lint:css-scope
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const APP = resolve(ROOT, 'app');
const rel = (p) => relative(ROOT, p);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const all = walk(APP).concat(walk(resolve(ROOT, 'lib')));
const modules = all.filter(
  (f) => /\.tsx?$/.test(f) && !f.includes('__tests__') && !f.endsWith('.stories.tsx'),
);

/** Resolve a relative import specifier to a file on disk, or null. */
function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const text = new Map(modules.map((f) => [f, readFileSync(f, 'utf8')]));
/** module → modules it imports; module → stylesheets it imports. */
const imports = new Map();
const sheetsOf = new Map();
for (const [file, src] of text) {
  const mods = new Set();
  const sheets = new Set();
  for (const [, spec] of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
    if (spec.endsWith('.css')) {
      const sheet = resolve(dirname(file), spec);
      if (existsSync(sheet)) sheets.add(sheet);
    } else {
      const target = resolveImport(file, spec);
      if (target) mods.add(target);
    }
  }
  imports.set(file, mods);
  sheetsOf.set(file, sheets);
}

/** Class names a stylesheet defines or scopes. */
function classesIn(sheet) {
  return new Set(
    [...readFileSync(sheet, 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]),
  );
}
const sheetClasses = new Map(
  [...new Set([...sheetsOf.values()].flatMap((s) => [...s]))].map((s) => [s, classesIn(s)]),
);
/**
 * Only NAMESPACED classes are checked. A bare word (`on`, `chip`, `row`) is a
 * modifier sheets qualify from the left (`.adm-toggle.on`) — owned by whatever
 * it hangs off, not by the sheet mentioning it, so treating it as owned would
 * report a leak for every such pair.
 */
const NAMESPACED = /^[a-z][a-z0-9]*-/;
for (const [, classes] of sheetClasses) {
  for (const c of [...classes]) if (!NAMESPACED.test(c)) classes.delete(c);
}
/** Every class any project stylesheet knows about — anything else is not ours. */
const known = new Set([...sheetClasses.values()].flatMap((s) => [...s]));

/**
 * Class names a module writes. Every `className` form here is a literal
 * somewhere, so only string literals are read; identifiers and calls are
 * ignored, and a name no stylesheet defines is dropped.
 */
function classesUsed(src) {
  const used = new Set();
  for (const [, expr] of src.matchAll(/className=(?:("[^"]*")|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    for (const [, literal] of (expr ?? '').matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      for (const token of (literal ?? '').split(/[\s${}]+/)) {
        if (known.has(token)) used.add(token);
      }
    }
  }
  return used;
}

/** Everything a route entry can render, transitively. */
function reachable(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const next of imports.get(file) ?? []) queue.push(next);
  }
  return seen;
}

const problems = [];
for (const page of modules.filter((f) => /\/(page|not-found|error)\.tsx$/.test(f))) {
  // A route mounts every layout from app/ down to its own directory, then the page.
  const entries = [page];
  for (let dir = dirname(page); dir.startsWith(APP); dir = dirname(dir)) {
    const layout = join(dir, 'layout.tsx');
    if (existsSync(layout)) entries.push(layout);
  }
  const rendered = reachable(entries);
  const loaded = new Set([...rendered].flatMap((f) => [...(sheetsOf.get(f) ?? [])]));
  const styled = new Set([...loaded].flatMap((s) => [...(sheetClasses.get(s) ?? [])]));
  for (const file of rendered) {
    for (const used of classesUsed(text.get(file) ?? '')) {
      if (styled.has(used)) continue;
      const homes = [...sheetClasses]
        .filter(([, cs]) => cs.has(used))
        .map(([s]) => rel(s))
        .join(', ');
      problems.push(`${rel(page)} renders ${rel(file)} → .${used} (defined in ${homes})`);
    }
  }
}

if (problems.length) {
  console.error('A route renders a class whose stylesheet that route does not load:\n');
  for (const p of [...new Set(problems)].sort()) console.error(`  ${p}`);
  console.error(
    '\nEither import that stylesheet in the route’s layout, or move the class ' +
      'into app/globals.css (loaded everywhere).',
  );
  process.exit(1);
}
console.log(`css-scope: ${sheetClasses.size} stylesheets, every route styles what it renders.`);
