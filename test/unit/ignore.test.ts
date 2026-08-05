import { describe, expect, it } from 'vitest';
import { globToRegExp, isIgnored } from '../../src/cli/ignore.js';

describe('globToRegExp', () => {
  it('matches a literal path exactly', () => {
    expect(globToRegExp('src/foo.ts').test('src/foo.ts')).toBe(true);
    expect(globToRegExp('src/foo.ts').test('src/bar.ts')).toBe(false);
  });

  it('* matches within a single path segment only', () => {
    const re = globToRegExp('src/*.controller.ts');
    expect(re.test('src/users.controller.ts')).toBe(true);
    expect(re.test('src/nested/users.controller.ts')).toBe(false);
  });

  it('** matches across path segments, including zero', () => {
    const re = globToRegExp('src/**/*.spec.ts');
    expect(re.test('src/users/users.spec.ts')).toBe(true);
    expect(re.test('src/users.spec.ts')).toBe(true);
    expect(re.test('src/a/b/c/users.spec.ts')).toBe(true);
    expect(re.test('src/users.controller.ts')).toBe(false);
  });

  it('? matches exactly one non-slash character', () => {
    const re = globToRegExp('a?.ts');
    expect(re.test('ab.ts')).toBe(true);
    expect(re.test('a.ts')).toBe(false);
    expect(re.test('abc.ts')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts of the pattern', () => {
    const re = globToRegExp('src/foo.bar+baz.ts');
    expect(re.test('src/foo.bar+baz.ts')).toBe(true);
    // Without escaping, "." would match any character and "+" would be a
    // quantifier — both must be treated literally.
    expect(re.test('srcXfooXbarbaz.ts')).toBe(false);
  });

  // Phase 4 review, finding S1: `**` used to compile to a bare `.*` with no
  // `/` anchoring, making `**/X/**` a substring match instead of a
  // segment match.
  describe('** is anchored to whole path segments (Phase 4 review, finding S1)', () => {
    it('**/test/** does not match a path that merely CONTAINS "test" as a substring of a segment', () => {
      const re = globToRegExp('**/test/**');
      expect(re.test('src/latest/alpha.controller.ts')).toBe(false);
      expect(re.test('src/test/alpha.controller.ts')).toBe(true);
    });

    it('**/node_modules/** does not match a segment that merely contains "node_modules" as a substring', () => {
      const re = globToRegExp('**/node_modules/**');
      expect(re.test('xnode_modules/foo.js')).toBe(false);
      expect(re.test('node_modules/foo.js')).toBe(true);
      expect(re.test('src/node_modules/foo.js')).toBe(true);
    });

    it('a ** that is not a standalone segment (src/**.ts) degrades to an ordinary single-segment *', () => {
      const re = globToRegExp('src/**.ts');
      expect(re.test('src/foo.ts')).toBe(true);
      // Must not cross `/` the way a real globstar would.
      expect(re.test('src/nested/foo.ts')).toBe(false);
    });
  });

  // Phase 4 review, finding S12: consecutive globstars compiled to
  // consecutive independent `.*`s, which backtrack catastrophically.
  it('a long chain of consecutive ** segments compiles to a single non-backtracking fragment (Phase 4 review, finding S12)', () => {
    const start = performance.now();
    const re = globToRegExp('**/**/**/**/**/**/*.spec.ts');
    const longPath = `${'a/'.repeat(40)}foo.controller.ts`;
    expect(re.test(longPath)).toBe(false);
    expect(re.test(`${'a/'.repeat(40)}foo.spec.ts`)).toBe(true);
    // Generous bound (real fix is near-instant; a regression to the old
    // per-globstar `.*` chain measured 10s+ for far shorter inputs).
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('a leading ./ or / on a pattern is stripped, so it still matches a baseDir-relative path', () => {
    expect(globToRegExp('./src/**').test('src/foo.ts')).toBe(true);
    expect(globToRegExp('/src/**').test('src/foo.ts')).toBe(true);
  });
});

describe('isIgnored', () => {
  it('is false with no patterns (non-vacuous default)', () => {
    expect(isIgnored('src/foo.ts', [])).toBe(false);
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
