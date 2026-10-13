import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTerms, scanLine, scanText, scopesFromLockfile, withoutPackageNames, wordsOf } from './deny-list.js';

// Made-up terms of the test's own: the real list never lives in the repo.
const terms = new Set(['zorblat', 'glimmer fen']);
const emDash = String.fromCharCode(0x2014);
const workspaceShaped = ['C', '0', 'ABCDEFGH1'].join('');
const sheetShaped = 'x'.repeat(44);
const home = ['', 'Users', 'someone', 'notes'].join('/');

describe('the deny-list check', () => {
  it('reads its terms from DENY_LIST, then from a .denylist file, and from nowhere else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deny-'));
    const file = join(dir, '.denylist');
    writeFileSync(file, '# a comment\nZorblat\n\nGlimmer  Fen\n');
    expect(loadTerms({ DENY_LIST: 'one\ntwo words' }, file)).toEqual(['one', 'two words']);
    expect(loadTerms({}, file)).toEqual(['zorblat', 'glimmer fen']);
    expect(loadTerms({}, join(dir, 'missing'))).toEqual([]);
    expect(loadTerms({ DENY_LIST: '   ' }, join(dir, 'missing'))).toEqual([]);
  });

  it('passes clean text', () => {
    expect(scanText('README.md', 'A Highland games needs forty volunteers and a problem-solving piper.', terms)).toEqual([]);
  });

  it('matches whole words and pairs, case-insensitively, including camelCase', () => {
    expect(scanText('a.ts', 'const x = "ZORBLAT";', terms).map((f) => f.rule)).toEqual(['denied word "zorblat"']);
    expect(scanText('a.ts', 'const zorblatName = 1;', terms)).toHaveLength(1);
    expect(scanText('a.ts', 'const zorblats = 1;', terms)).toHaveLength(0);
    expect(scanText('a.md', 'Off to Glimmer Fen next week', terms).map((f) => f.rule)).toEqual(['denied phrase "glimmer fen"']);
    expect(wordsOf('myNameHere')).toEqual(['my', 'name', 'here']);
  });

  it('catches an em dash, a home path, a workspace-shaped id and a spreadsheet-shaped id', () => {
    expect(scanText('a.md', `one ${emDash} two`, terms).map((f) => f.rule)).toEqual(['em dash']);
    expect(scanText('a.md', home, terms).map((f) => f.rule)).toEqual(['home-directory path']);
    expect(scanText('a.md', `channel ${workspaceShaped}`, terms)[0]?.rule).toMatch(/^workspace-shaped id/);
    expect(scanText('a.md', `sheet ${sheetShaped}`, terms)[0]?.rule).toMatch(/^spreadsheet-shaped id/);
  });

  it('exempts the licence and package.json author fields, but nothing else in them', () => {
    expect(scanText('LICENSE', 'Copyright (c) 2026 Zorblat', terms)).toEqual([]);
    expect(scanText('package.json', '  "author": "Zorblat",', terms)).toEqual([]);
    expect(scanText('package.json', '  "description": "Zorblat",', terms)).toHaveLength(1);
    expect(scanText('package-lock.json', `"integrity": "${sheetShaped}"`, terms)).toEqual([]);
  });

  it('treats a package specifier in an installed scope as a package name, and nothing else', () => {
    const lock = JSON.stringify({ packages: { '': {}, 'node_modules/@zorblat/sdk': {}, 'node_modules/@zorblat/sdk/node_modules/@other/x': {}, 'node_modules/left-pad': {} } });
    const scopes = scopesFromLockfile(lock);
    expect([...scopes].sort()).toEqual(['other', 'zorblat']);
    expect(scanText('a.ts', "import Client from '@zorblat/sdk';", terms, scopes)).toEqual([]);
    expect(scanText('package-lock.json', '"resolved": "https://registry.npmjs.org/@zorblat/sdk/-/sdk-1.0.0.tgz",', terms, scopes)).toEqual([]);
    // The bare word, anywhere else on the same line or alone, is still a finding.
    expect(scanText('a.ts', "import Zorblat from '@zorblat/sdk';", terms, scopes)).toHaveLength(1);
    expect(scanText('a.md', 'Built on the zorblat API.', terms, scopes)).toHaveLength(1);
    // A scope that is not installed is not exempt.
    expect(scanText('a.ts', "import x from '@zorblat/sdk';", terms, new Set(['other']))).toHaveLength(1);
    expect(withoutPackageNames('a @zorblat/sdk b', scopes)).toBe('a   b');
    // In the lockfile only, the bin entry npm writes for an installed scoped package is its name too.
    expect(scanText('package-lock.json', '        "zorblat-sdk": "bin/cli"', terms, scopes)).toEqual([]);
    expect(scanText('package.json', '        "zorblat-sdk": "bin/cli"', terms, scopes)).toHaveLength(1);
    expect(scanText('package-lock.json', '        "zorblat-sdk": "a description"', terms, scopes)).toHaveLength(1);
  });

  it('does not take a git id or a sha256 digest for a document id, and still catches a real one', () => {
    const hex = (seed: string, n: number): string => seed.repeat(n / seed.length);
    expect(scanLine(`Merge ${hex('f5', 40)} into ${hex('bd', 40)}`, terms)).toEqual([]);
    expect(scanLine(`"fingerprint":"${hex('8e', 64)}"`, terms)).toEqual([]);
    expect(scanLine(`see ${sheetShaped}`, terms)[0]).toMatch(/^spreadsheet-shaped id/);
    expect(scanLine(`mixed ${hex('aB', 44)}`, terms)[0]).toMatch(/^spreadsheet-shaped id/);
  });
});
