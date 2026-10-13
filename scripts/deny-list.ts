/**
 * The deny-list check. Fails the build if any tracked file (or, with --history, any commit message or diff) holds:
 *
 *   - a word or two-word phrase from the deny-list: names and places that must never appear in this repo. The list is
 *     never kept in the repo. It comes from the DENY_LIST environment variable (one term per line; a CI secret), or
 *     failing that from a gitignored `.denylist` file in the repo root. An empty or missing list fails the check, so
 *     CI cannot pass silently. Matching is case-insensitive on whole words and pairs of words, camelCase split;
 *   - a home-directory path;
 *   - anything shaped like a chat workspace id or a spreadsheet id;
 *   - an em dash.
 *
 * Exempt: the LICENSE file, the "author" field of package.json files (the author's own name), the single empty
 * API-key variable in .env.example, and npm package specifiers ("@scope/name") whose scope is an installed dependency
 * in package-lock.json: a package name is not a mention. The bare word stays denied everywhere else, so code imports
 * such a package under a neutral local name. In --history mode, commit trailers are exempt too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Reads the terms: DENY_LIST first, then `.denylist`. Lower-cased, one per line, blank lines and # comments ignored. */
export function loadTerms(env: NodeJS.ProcessEnv = process.env, file = '.denylist'): string[] {
  const raw = env.DENY_LIST?.trim() ? env.DENY_LIST : existsSync(file) ? readFileSync(file, 'utf8') : '';
  return raw
    .split(/\r?\n/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((t) => t && !t.startsWith('#'));
}

const emDash = String.fromCharCode(0x2014);
const homePath = new RegExp(['', 'Users', ''].join('\\/'));
const workspaceId = /\b[CDU][0-9A-Z]{8,}\b/;
const sheetId = /[A-Za-z0-9_-]{40,}/;

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Words of a line, lower-cased, camelCase split, so "myNameHere" is "my name here". */
export function wordsOf(line: string): string[] {
  return line
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export interface ScanOptions {
  /** Skip the long-id check (lockfiles are full of integrity hashes). */
  skipLongIds?: boolean;
  /** npm scopes of installed dependencies: "@scope/name" specifiers in these scopes are package names, not mentions. */
  allowedScopes?: Set<string>;
  /** The line is from package-lock.json, where an installed scoped package's bin entry is also its name. */
  lockfile?: boolean;
}

const packageSpecifier = /@([a-z0-9][a-z0-9._-]*)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._/-]*)?/g;

/** A lockfile "bin" entry an installed scoped package declares: npm names it "<scope>-<name>". */
const lockfileBinEntry = /^(\s*)"([a-z0-9][a-z0-9._-]*)": "bin\/[A-Za-z0-9._/-]+"(,?)$/;

/** Removes package specifiers in an allowed scope, so only the rest of the line is checked. */
export function withoutPackageNames(line: string, scopes: Set<string> | undefined, lockfile = false): string {
  if (!scopes?.size) return line;
  if (lockfile) {
    const bin = lockfileBinEntry.exec(line);
    if (bin && [...scopes].some((scope) => bin[2]?.startsWith(`${scope}-`))) return '';
  }
  return line.replace(packageSpecifier, (match, scope: string) => (scopes.has(scope) ? ' ' : match));
}

/**
 * Blanks hash digests: git object ids (40 lowercase hex characters, which commit messages name) and sha256 digests
 * (64, which the engine's approval fingerprints are, and which exported event logs carry). A document id is mixed-case
 * base64url, never pure lowercase hex, so the long-id rule still catches those.
 */
export function withoutDigests(line: string): string {
  return line.replace(/\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/g, (id) => ' '.repeat(id.length));
}

/** The scopes of every package installed according to the lockfile. */
export function scopesFromLockfile(text: string): Set<string> {
  const scopes = new Set<string>();
  const lock = JSON.parse(text) as { packages?: Record<string, unknown> };
  for (const key of Object.keys(lock.packages ?? {})) {
    const match = /(?:^|\/)node_modules\/@([a-z0-9][a-z0-9._-]*)\/[^/]+$/.exec(key);
    if (match?.[1]) scopes.add(match[1]);
  }
  return scopes;
}

export function scanLine(raw: string, terms: Set<string>, options: ScanOptions = {}): string[] {
  const rules: string[] = [];
  const line = withoutDigests(withoutPackageNames(raw, options.allowedScopes, options.lockfile));
  const words = wordsOf(line);
  for (let i = 0; i < words.length; i++) {
    const one = words[i] ?? '';
    if (terms.has(one)) rules.push(`denied word "${one}"`);
    const two = i + 1 < words.length ? `${one} ${words[i + 1] ?? ''}` : '';
    if (two && terms.has(two)) rules.push(`denied phrase "${two}"`);
  }
  if (line.includes(emDash)) rules.push('em dash');
  if (homePath.test(line)) rules.push('home-directory path');
  if (workspaceId.test(line)) rules.push(`workspace-shaped id "${workspaceId.exec(line)?.[0] ?? ''}"`);
  if (!options.skipLongIds && sheetId.test(line)) rules.push(`spreadsheet-shaped id "${sheetId.exec(line)?.[0] ?? ''}"`);
  return rules;
}

/** Lines that are exempt: the licence's copyright line and package.json author fields. */
export function isExemptLine(file: string, line: string): boolean {
  if (/(^|\/)LICENSE$/.test(file)) return true;
  if (/(^|\/)package\.json$/.test(file) && /^[+-]?\s*"author":/.test(line)) return true;
  // The brief asks for this one empty variable for Phase 1b; its name is the provider's convention (see decisions).
  if (/(^|\/)\.env\.example$/.test(file) && /^[+-]?[A-Z]+_API_KEY=$/.test(line)) return true;
  return false;
}

export function scanText(file: string, text: string, terms: Set<string>, allowedScopes?: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const skipLongIds = /(^|\/)package-lock\.json$/.test(file);
  text.split('\n').forEach((line, i) => {
    if (isExemptLine(file, line)) return;
    for (const rule of scanLine(line, terms, { skipLongIds, allowedScopes, lockfile: skipLongIds })) findings.push({ file, line: i + 1, rule, text: line.trim().slice(0, 120) });
  });
  return findings;
}

function installedScopes(): Set<string> {
  return existsSync('package-lock.json') ? scopesFromLockfile(readFileSync('package-lock.json', 'utf8')) : new Set();
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !/\.(png|jpg|jpeg|gif|ico|db)$/i.test(f));
}

/** Commit messages and diffs, file by file, with trailers exempt. */
function scanHistory(terms: Set<string>, allowedScopes: Set<string>): Finding[] {
  const log = execFileSync('git', ['log', '-p', '--format=commit-message%n%B'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const findings: Finding[] = [];
  let file = 'commit message';
  log.split('\n').forEach((line, i) => {
    if (line === 'commit-message') {
      file = 'commit message';
      return;
    }
    const diffHeader = /^diff --git a\/(.+) b\//.exec(line);
    if (diffHeader) {
      file = diffHeader[1] ?? file;
      return;
    }
    if (file === 'commit message' && /^Co-Authored-By: /.test(line)) return;
    if (isExemptLine(file, line)) return;
    const lockfile = /(^|\/)package-lock\.json$/.test(file);
    // A diff header names a file: its path is checked for denied words, not taken for a document id.
    const skipLongIds = lockfile || /^index [0-9a-f]+\.\.[0-9a-f]+/.test(line) || /^(\+\+\+|---) [ab]\//.test(line);
    for (const rule of scanLine(line.replace(/^[+-]/, ''), terms, { skipLongIds, allowedScopes, lockfile })) findings.push({ file: `history: ${file}`, line: i + 1, rule, text: line.trim().slice(0, 120) });
  });
  return findings;
}

function main(): void {
  const history = process.argv.includes('--history');
  const terms = new Set(loadTerms());
  if (!terms.size) {
    process.stdout.write('Deny-list: no terms. Set DENY_LIST (one term per line) or write a .denylist file. Failing closed.\n');
    process.exit(2);
  }
  const scopes = installedScopes();
  const findings = history ? scanHistory(terms, scopes) : trackedFiles().flatMap((file) => scanText(file, readFileSync(file, 'utf8'), terms, scopes));
  if (findings.length) {
    for (const f of findings) process.stdout.write(`${f.file}:${f.line}: ${f.rule}\n    ${f.text}\n`);
    process.stdout.write(`\nDeny-list: ${findings.length} finding(s).\n`);
    process.exit(1);
  }
  process.stdout.write(`Deny-list: clean against ${terms.size} terms (${history ? 'all commit messages and diffs' : `${trackedFiles().length} files`}).\n`);
}

if (process.argv[1] && /deny-list\.ts$/.test(process.argv[1])) main();
