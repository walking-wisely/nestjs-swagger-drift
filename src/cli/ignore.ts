/**
 * Glob matching for `--ignore` (PLAN.md §5 Phase 4). CLI-only, like
 * everything else that touches paths (PLAN §3) — `core/` never sees a glob
 * or a raw filesystem path, only `ts.Node`s.
 *
 * Backed by `picomatch` — the de facto standard glob matcher in the JS
 * ecosystem (what `fast-glob`, `micromatch`, and Vite use under the hood):
 * a familiar, `.gitignore`-flavored dialect instead of a bespoke one, and
 * a matcher that's been fuzzed against ReDoS across years of real-world use
 * rather than hardened one bug at a time by hand (this module used to be a
 * hand-rolled glob-to-`RegExp` compiler; see git history for the
 * catastrophic-backtracking bug that motivated the switch).
 *
 * Patterns are matched against a POSIX-style path **relative to the CLI's
 * base directory** (see `index.ts`'s `baseDir`), never an absolute path —
 * `--ignore 'test/**'` should mean the same thing regardless of where the
 * repo happens to be checked out. A leading `./` or `/` on a pattern is
 * stripped before compiling for the same reason: `--ignore './src/**'` and
 * `--ignore '/src/**'` read as "the `src` directory at the project root" to
 * anyone used to shell globs or `.gitignore`, but the paths this module
 * matches against never start with `./` or `/` — left unstripped, picomatch
 * treats a leading `/` as an absolute anchor, and the pattern would never
 * match anything.
 *
 * A pattern with no `/` at all is also matched against every individual
 * path segment, not just the full relative path — standard `.gitignore`
 * behavior (a bare `node_modules` excludes that directory at any depth, not
 * just at the project root), which picomatch's own `basename` option
 * doesn't quite give us (it only checks the *last* segment).
 */

import picomatch from 'picomatch';

function normalizePattern(pattern: string): string {
  if (pattern.startsWith('./')) return pattern.slice(2);
  if (pattern.startsWith('/')) return pattern.slice(1);
  return pattern;
}

// Compiled matchers are cached per (normalized) pattern text — `isIgnored`
// is called once per discovered file per `--ignore` pattern, so recompiling
// on every call turns a handful of patterns into thousands of redundant
// compilations on a real repo. Keyed on the raw pattern string (not the
// normalized one) since that's what callers pass in.
const compiledPatternCache = new Map<string, picomatch.Matcher>();

function compileCached(pattern: string): picomatch.Matcher {
  const cached = compiledPatternCache.get(pattern);
  if (cached) return cached;
  const compiled = picomatch(normalizePattern(pattern));
  compiledPatternCache.set(pattern, compiled);
  return compiled;
}

/**
 * `true` if `relativePath` (already `/`-separated, relative to `baseDir`)
 * matches any of `patterns`. A pattern with no `/` at all is matched against
 * every path segment too (not just the full relative path), so a bare
 * `--ignore node_modules` behaves the way users expect from `.gitignore`
 * rather than requiring `--ignore '**\/node_modules/**'`.
 */
export function isIgnored(relativePath: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const segments = relativePath.split('/');
  return patterns.some((pattern) => {
    const isMatch = compileCached(pattern);
    if (isMatch(relativePath)) return true;
    if (!pattern.includes('/') && segments.some((segment) => isMatch(segment))) return true;
    return false;
  });
}
