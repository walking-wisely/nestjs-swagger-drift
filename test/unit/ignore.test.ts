import { describe, expect, it } from 'vitest';
import { isIgnored } from '../../src/cli/ignore.js';

describe('isIgnored', () => {
  it('is false with no patterns (non-vacuous default)', () => {
    expect(isIgnored('src/foo.ts', [])).toBe(false);
  });

  it('matches a literal path exactly', () => {
    expect(isIgnored('src/foo.ts', ['src/foo.ts'])).toBe(true);
    expect(isIgnored('src/bar.ts', ['src/foo.ts'])).toBe(false);
  });

  it('* matches within a single path segment only', () => {
    expect(isIgnored('src/users.controller.ts', ['src/*.controller.ts'])).toBe(true);
    expect(isIgnored('src/nested/users.controller.ts', ['src/*.controller.ts'])).toBe(false);
  });

  it('** matches across path segments, including zero', () => {
    const pattern = 'src/**/*.spec.ts';
    expect(isIgnored('src/users/users.spec.ts', [pattern])).toBe(true);
    expect(isIgnored('src/users.spec.ts', [pattern])).toBe(true);
    expect(isIgnored('src/a/b/c/users.spec.ts', [pattern])).toBe(true);
    expect(isIgnored('src/users.controller.ts', [pattern])).toBe(false);
  });

  it('? matches exactly one non-slash character', () => {
    const pattern = 'a?.ts';
    expect(isIgnored('ab.ts', [pattern])).toBe(true);
    expect(isIgnored('a.ts', [pattern])).toBe(false);
    expect(isIgnored('abc.ts', [pattern])).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literal glob characters', () => {
    const pattern = 'src/foo.bar+baz.ts';
    expect(isIgnored('src/foo.bar+baz.ts', [pattern])).toBe(true);
    // Without literal handling, "." would match any character and "+" would
    // be a quantifier — both must be treated as ordinary characters here.
    expect(isIgnored('srcXfooXbarbaz.ts', [pattern])).toBe(false);
  });

  describe('** is anchored to whole path segments', () => {
    it('**/test/** does not match a path that merely CONTAINS "test" as a substring of a segment', () => {
      const pattern = '**/test/**';
      expect(isIgnored('src/latest/alpha.controller.ts', [pattern])).toBe(false);
      expect(isIgnored('src/test/alpha.controller.ts', [pattern])).toBe(true);
    });

    it('**/node_modules/** does not match a segment that merely contains "node_modules" as a substring', () => {
      const pattern = '**/node_modules/**';
      expect(isIgnored('xnode_modules/foo.js', [pattern])).toBe(false);
      expect(isIgnored('node_modules/foo.js', [pattern])).toBe(true);
      expect(isIgnored('src/node_modules/foo.js', [pattern])).toBe(true);
    });

    it('a ** that is not a standalone segment (src/**.ts) degrades to an ordinary single-segment *', () => {
      const pattern = 'src/**.ts';
      expect(isIgnored('src/foo.ts', [pattern])).toBe(true);
      // Must not cross `/` the way a real globstar would.
      expect(isIgnored('src/nested/foo.ts', [pattern])).toBe(false);
    });
  });

  it('a long chain of consecutive ** segments matches quickly, no catastrophic backtracking', () => {
    const pattern = '**/**/**/**/**/**/*.spec.ts';
    const longPath = `${'a/'.repeat(40)}foo.controller.ts`;
    const start = performance.now();
    expect(isIgnored(longPath, [pattern])).toBe(false);
    expect(isIgnored(`${'a/'.repeat(40)}foo.spec.ts`, [pattern])).toBe(true);
    // Generous bound (real fix is near-instant; a regression to a naive
    // per-globstar backtracking implementation measured 10s+ for far
    // shorter inputs).
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('a leading ./ or / on a pattern is stripped, so it still matches a baseDir-relative path', () => {
    expect(isIgnored('src/foo.ts', ['./src/**'])).toBe(true);
    expect(isIgnored('src/foo.ts', ['/src/**'])).toBe(true);
  });

  it('matches a full relative-path glob', () => {
    expect(isIgnored('test/fixtures/foo.ts', ['test/**'])).toBe(true);
    expect(isIgnored('src/foo.ts', ['test/**'])).toBe(false);
  });

  it('matches a bare (no-slash) pattern against any path segment', () => {
    expect(isIgnored('src/generated/foo.ts', ['generated'])).toBe(true);
    expect(isIgnored('src/foo.ts', ['generated'])).toBe(false);
  });

  it('is true if any of several patterns match', () => {
    expect(isIgnored('src/foo.spec.ts', ['test/**', '**/*.spec.ts'])).toBe(true);
  });

  it('**/test/** does not exclude a sibling path like src/latest/... (Phase 4 review, finding S1)', () => {
    expect(isIgnored('src/latest/alpha.controller.ts', ['**/test/**'])).toBe(false);
    expect(isIgnored('src/test/alpha.controller.ts', ['**/test/**'])).toBe(true);
  });
});
