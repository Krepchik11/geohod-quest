/**
 * Every repository path a document names must exist.
 *
 * This is the check that was missing. `DEPLOYMENT.md` told an operator to keep
 * `platform/frontend/package-lock.json` "authoritative and regenerated" for
 * three commits after that file was deleted — the docs commit that was supposed
 * to record the change edited a different section and left this one standing.
 * Nothing failed, because nothing was looking.
 *
 * It is deliberately NOT a link checker. A link checker answers "does this URL
 * resolve", which says nothing about a sentence naming a file that no longer
 * exists. This answers the question that actually goes stale here: this repo's
 * documentation is dense with concrete paths, and a path is the one claim in
 * prose a machine can check exactly.
 *
 * Truth comes from `git ls-files`, not the working tree, so build output and
 * untracked scratch files can never satisfy a documented path.
 *
 * Run: npm run lint:doc-paths
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** The repository root, two levels above platform/frontend/scripts. */
const ROOT = resolve(process.cwd(), '../..');

function markdownFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    // Dot-directories and build output hold nobody's documentation, and a
    // broken symlink inside one (a stale .venv) must not abort the check.
    if (name.startsWith('.') || name === 'node_modules' || name === 'target') continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) markdownFiles(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every path git tracks, plus every directory on the way to one. */
function trackedPaths() {
  const listed = execSync('git ls-files', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
    .split('\n')
    .filter(Boolean);
  const paths = new Set(listed);
  for (const file of listed) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) paths.add(parts.slice(0, i).join('/'));
  }
  return paths;
}

const TRACKED = trackedPaths();
/** Last segment of every tracked path, for the docs that name a file alone. */
const BASENAMES = new Set([...TRACKED].map((p) => p.split('/').pop()));

/** Extensions that make a bare word a source path even with no slash in it. */
const SOURCE_EXT =
  /\.(rs|ts|tsx|js|mjs|jsx|css|json|toml|sql|yml|yaml|md|sh|html|container|snippet|example)$/;

/**
 * Things that look like paths but are not repository paths. Every entry earned
 * its place against the real documents — a check that cries wolf is a check
 * somebody deletes.
 */
function notAPath(text) {
  return (
    text.includes('://') || // URLs, connection strings
    text.includes('=') || // Image=…, KEY=value
    /\s/.test(text) || // commands, prose
    /[*?{}$<>|()[\]]/.test(text) || // globs, placeholders, shell
    /^[A-Z][A-Z0-9_]*$/.test(text) || // env var names
    /^\d/.test(text) || // versions, sizes
    /^[a-z0-9.-]+\.(io|com|ru|org|net|dev|app)\//.test(text) || // ghcr.io/…, github.com/…
    // An absolute path in these docs is an HTTP route; the few that name real
    // machine locations are outside the repository either way.
    text.startsWith('/') ||
    text.startsWith('~') ||
    // Installed dependencies and per-machine artifacts: real on disk, never in
    // git, so "is it tracked" is the wrong question to ask of them.
    text.startsWith('node_modules/') ||
    text.startsWith('.')
  );
}

/** Candidate repository paths named in one document. */
function pathsIn(markdown) {
  const found = new Set();
  // Fenced code blocks are commands and config, not claims about the tree.
  const prose = markdown.replace(/```[\s\S]*?```/g, '');
  for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) {
    const text = span
      .trim()
      .replace(/[.,;:]$/, '')
      .replace(/:\d+(-\d+)?$/, '') // a file:line citation still names the file
      .replace(/\/$/, '');
    if (!text || notAPath(text)) continue;
    if (!text.includes('/') && !SOURCE_EXT.test(text)) continue;
    found.add(text);
  }
  return found;
}

/**
 * A documented path is satisfied when git tracks something it identifies: a
 * fragment must be the tail of a tracked path (so `src/handlers` resolves from
 * any document), and a bare filename must match a tracked basename — the docs
 * legitimately write `features.rs` with no directory.
 */
function isTracked(candidate, docDir) {
  // A `../`-style link is relative to the document, so resolve it there first.
  if (candidate.startsWith('.')) {
    const absolute = relative(ROOT, resolve(docDir, candidate));
    return TRACKED.has(absolute);
  }
  if (TRACKED.has(candidate)) return true;
  if (!candidate.includes('/')) return BASENAMES.has(candidate);
  const suffix = `/${candidate}`;
  for (const path of TRACKED) if (path.endsWith(suffix)) return true;
  return false;
}

/**
 * Paths git deliberately ignores are not drift. `platform/tools/bubble-import/`
 * is a gitignored 286 MB one-off importer, and `load.sql` is something it
 * generates — DEPLOYMENT.md is right to name both. Asking git which paths it
 * ignores is exact, so this needs no hand-kept exception list.
 */
function ignoredByGit(candidates) {
  if (candidates.length === 0) return new Set();
  try {
    const answer = execSync('git check-ignore --stdin --no-index', {
      cwd: ROOT,
      input: candidates.join('\n'),
      encoding: 'utf8',
    });
    return new Set(answer.split('\n').filter(Boolean));
  } catch {
    // check-ignore exits 1 when nothing matched, and prints the matches it did
    // find on stdout — which execSync discards on a non-zero exit. Fall back to
    // asking one path at a time so a single miss cannot blind the whole run.
    const ignored = new Set();
    for (const candidate of candidates) {
      try {
        execSync(`git check-ignore --no-index -q -- ${JSON.stringify(candidate)}`, { cwd: ROOT });
        ignored.add(candidate);
      } catch {
        /* not ignored */
      }
    }
    return ignored;
  }
}

const problems = [];
const unresolved = [];
for (const doc of markdownFiles(ROOT)) {
  // Only repository documents are judged. `platform/tools/bubble-import/` is
  // gitignored on purpose (a 286 MB one-off importer), and its README correctly
  // names its own untracked sources and generated outputs.
  if (!TRACKED.has(relative(ROOT, doc))) continue;
  const markdown = readFileSync(doc, 'utf8');
  const lines = markdown.split('\n');
  for (const candidate of pathsIn(markdown)) {
    if (isTracked(candidate, join(doc, '..'))) continue;
    const at = lines.findIndex((l) => l.includes(`\`${candidate}`)) + 1;
    unresolved.push({ candidate, where: `${relative(ROOT, doc)}:${at}` });
  }
}

const ignored = ignoredByGit([...new Set(unresolved.map((u) => u.candidate))]);
for (const { candidate, where } of unresolved) {
  if (ignored.has(candidate)) continue;
  problems.push(`${where} names \`${candidate}\`, which git neither tracks nor ignores`);
}

if (problems.length) {
  console.error('Documentation names a path that is not in the repository:\n');
  for (const p of problems.sort()) console.error(`  ${p}`);
  console.error(
    '\nEither fix the path, delete the claim, or — if it is genuinely not a\n' +
      'repository path — teach `notAPath()` in this script why.',
  );
  process.exit(1);
}
console.log(`doc-paths: every path named in a document is tracked (${TRACKED.size} known).`);
