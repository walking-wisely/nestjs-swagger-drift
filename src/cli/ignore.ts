/**
 * Minimal glob matching for `--ignore` (PLAN.md §5 Phase 4). CLI-only, like
 * everything else that touches paths (PLAN §3) — `core/` never sees a glob
 * or a raw filesystem path, only `ts.Node`s.
 *
 * Deliberately not a dependency: the supported syntax is a small, well-known
 * subset (`*`, `**`, `?`, plain segments) — a full `.gitignore`-compatible
 * matcher (negation, `!`, brace expansion, character classes) is more than a
 * CLI flag whose job is "skip generated/test files" needs, and every glob
 * library considered pulls in either a native binding or a nontrivial
 * transitive tree for a single call site.
 *
 * Patterns are matched against a POSIX-style path **relative to the CLI's
 * base directory** (see `index.ts`'s `baseDir`), never an absolute path —
 * `--ignore 'test/**'` should mean the same thing regardless of where the
 * repo happens to be checked out. A leading `./` or `/` on a pattern is
 * stripped before compiling for the same reason: `--ignore './src/**'` and
 * `--ignore '/src/**'` read as "the `src` directory at the project root" to
 * anyone used to shell globs or `.gitignore`, but the paths this module
 * matches against never start with `./` or `/` — left unstripped, both
 * patterns would compile to a regex that can never match anything, silently
 * ignoring nothing (post-Phase-4-review fix).
 */

const GLOB_METACHARACTER = /[.*+?^${}()|[\]\\]/;

function normalizePattern(pattern: string): string {
  if (pattern.startsWith('./')) return pattern.slice(2);
  if (pattern.startsWith('/')) return pattern.slice(1);
  return pattern;
}

/**
 * Compiles a single glob pattern to a `RegExp` anchored to the whole
 * (relative, `/`-separated) path.
 *
 * - `**` matches any number of **whole path segments**, including zero, but
 *   only when it stands alone as a full segment — i.e. immediately preceded
 *   by `/` (or the start of the pattern) and immediately followed by `/` (or
 *   the end of the pattern). `src/**\/*.spec.ts` also matches
 *   `src/foo.spec.ts` directly under `src`; `**` at the very end of a
 *   pattern (`test/**`) matches everything under `test/`, slashes included.
 *   A run of `*`s that ISN'T segment-standalone (`src/**.ts`, `foo**bar`)
 *   degrades to a single ordinary `*` — standard glob behavior, and
 *   post-Phase-4-review fix: it used to cross `/` boundaries it shouldn't
 *   have (a pattern like `**\/test\/**` matched `latest` as a substring of
 *   a path segment, not just a `test` path segment) and, worse, chains of
 *   consecutive globstars compiled to chains of independent `.*`s that
 *   backtracked catastrophically on deep paths (measured: 10s+ for a
 *   handful of consecutive globstars against a single 78-char path).
 *   Consecutive/redundant globstars collapse to one for the same reason.
 * - `*` matches any run of characters except `/` (one path segment).
 * - `?` matches exactly one character except `/`.
 * - Anything else is escaped and matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePattern(pattern);
  let source = '';
  let i = 0;
  // `true` once a globstar fragment has just been emitted, so a directly
  // adjacent second (or third, ...) globstar segment doesn't emit another
  // independent `.*`-shaped fragment next to it — see the ReDoS note above.
  let justEmittedGlobstar = false;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (ch === '*' && normalized[i + 1] === '*') {
      let j = i;
      while (normalized[j] === '*') j++;
      const isLeadingBoundary = i === 0 || normalized[i - 1] === '/';
      const isTrailingBoundary = j === normalized.length || normalized[j] === '/';

      if (isLeadingBoundary && isTrailingBoundary) {
        if (j === normalized.length) {
          // Trailing `**`: matches the rest of the path, slashes included.
          if (!justEmittedGlobstar) source += '.*';
          i = j;
        } else {
          // `**/`: zero or more whole segments, each followed by `/`.
          if (!justEmittedGlobstar) source += '(?:[^/]*/)*';
          i = j + 1; // also consumes the trailing slash
        }
        justEmittedGlobstar = true;
        continue;
      }

      // Not segment-standalone (e.g. `src/**.ts`) — degrades to a plain `*`.
      source += '[^/]*';
      i = j;
      justEmittedGlobstar = false;
      continue;
    }

    if (ch === '*') {
      source += '[^/]*';
      i++;
      justEmittedGlobstar = false;
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      i++;
      justEmittedGlobstar = false;
      continue;
    }
    source += GLOB_METACHARACTER.test(ch ?? '') ? `\\${ch}` : ch;
    i++;
    justEmittedGlobstar = false;
  }
  return new RegExp(`^${source}$`);
}

// Compiled regexes are cached per (normalized) pattern text — `isIgnored` is
// called once per discovered file per `--ignore` pattern, so recompiling on
// every call (as this used to) turns a handful of patterns into thousands of
// redundant `RegExp` constructions on a real repo. Keyed on the raw pattern
// string (not the normalized one) since that's what callers pass in.
const compiledPatternCache = new Map<string, RegExp>();

function compileCached(pattern: string): RegExp {
  const cached = compiledPatternCache.get(pattern);
  if (cached) return cached;
  const compiled = globToRegExp(pattern);
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
    const regExp = compileCached(pattern);
    if (regExp.test(relativePath)) return true;
    if (!pattern.includes('/') && segments.some((segment) => regExp.test(segment))) return true;
    return false;
  });
}
