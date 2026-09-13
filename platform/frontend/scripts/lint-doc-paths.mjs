/**
 * Every repository path a document names must be one git tracks or deliberately
 * ignores — plus one value that is not a path: the frontend origin, which must
 * match the deploy unit.
 *
 * Not a link checker: a link checker asks whether a URL resolves, which says
 * nothing about a sentence naming a file that no longer exists.
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
    // A broken symlink in a dot-dir (a stale .venv) must not abort the check.
    if (name.startsWith('.') || name === 'node_modules' || name === 'target') continue;
    const full = join(dir, name);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) markdownFiles(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Paths this repo owns — tracked plus staged additions — and their directories.
 * Additions count, or a new file would go unchecked until the NEXT commit.
 */
function ownedPaths() {
  const listed = execSync('git ls-files --cached --others --exclude-standard', {
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

const TRACKED = ownedPaths();
/** Last segment of every tracked path, for the docs that name a file alone. */
const BASENAMES = new Set([...TRACKED].map((p) => p.split('/').pop()));

/** Extensions that make a bare word a source path even with no slash in it. */
const SOURCE_EXT =
  /\.(rs|ts|tsx|js|mjs|jsx|css|json|toml|sql|yml|yaml|md|sh|html|container|snippet|example)$/;

/**
 * Path-shaped things that are not repository paths. Every entry earned its
 * place against the real documents.
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
    // An absolute path here is an HTTP route, or a machine location.
    text.startsWith('/') ||
    text.startsWith('~') ||
    // Real on disk, never in git.
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
 * A fragment must be the tail of an owned path; a bare filename must match an
 * owned basename, since the docs legitimately write `features.rs` alone.
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
 * Ignored paths are not drift: platform/tools/bubble-import/ and what it
 * generates are gitignored on purpose. Asking git beats a hand-kept list.
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
    // check-ignore exits 1 when nothing matched, and execSync then discards the
    // matches it DID print. Ask one at a time so a miss cannot blind the run.
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
  // Ignored trees are out of scope on both sides: their READMEs correctly name
  // their own untracked sources.
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

/**
 * The origin the docs name must be the one the deploy unit sets. These once
 * disagreed, so the runbook produced a CORS rejection on every API call. The
 * unit is the oracle — it is what runs.
 */
function originDrift() {
  const unit = join(ROOT, 'platform/deploy/geohod-quest-api.container');
  const text = readFileSync(unit, 'utf8');
  const declared = new Set(
    [...text.matchAll(/^Environment=(?:CORS_ALLOWED_ORIGINS|FRONTEND_BASE)=(.+)$/gm)]
      .flatMap(([, value]) => value.split(','))
      .map((origin) => origin.trim())
      // The Vercel preview wildcard is not a host anyone documents.
      .filter((origin) => origin.startsWith('https://') && !origin.includes('*')),
  );
  if (declared.size === 0) return [];

  const site = readFileSync(join(ROOT, 'platform/frontend/lib/site.ts'), 'utf8');
  const named = new Set(
    [...site.matchAll(/https:\/\/[a-z0-9.-]+/g)].map(([origin]) => origin),
  );
  return [...named]
    .filter((origin) => !declared.has(origin))
    .map(
      (origin) =>
        `platform/frontend/lib/site.ts names ${origin}, but ` +
        `platform/deploy/geohod-quest-api.container declares ${[...declared].join(', ')}`,
    );
}
problems.push(...originDrift());

if (problems.length) {
  console.error('Documentation disagrees with the repository:\n');
  for (const p of problems.sort()) console.error(`  ${p}`);
  console.error(
    '\nFor a path: fix it, delete the claim, or — if it genuinely is not a\n' +
      'repository path — teach `notAPath()` in this script why.\n' +
      'For an origin: the deploy unit is the oracle, because it is what runs.',
  );
  process.exit(1);
}
console.log(`doc-paths: every path named in a document is tracked (${TRACKED.size} known).`);
