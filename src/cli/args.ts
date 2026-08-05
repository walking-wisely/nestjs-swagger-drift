/**
 * Argv parsing for the CLI (PLAN.md §5 Phase 4's flag surface). Split out of
 * `index.ts` so it's independently unit-testable without spinning up a
 * `ts.Program`.
 *
 * ## Why unknown/malformed flags are hard errors
 *
 * The pre-Phase-4 parser silently dropped anything it didn't recognize.
 * That's exactly the "silent-green failure" this whole tool exists to
 * prevent, one layer up: a CI job that runs `nestjs-swagger-drift --porject
 * ./tsconfig.json` (typo) would previously fall through to "no `--project`
 * given," print usage, and — worse — a typo'd *option value* flag like
 * `--fail-on nonr` would just be silently accepted and do nothing. Every
 * branch below either accepts a flag or returns a `{ ok: false }` error;
 * nothing is dropped quietly. See `index.ts`'s `main()` for how a parse
 * failure maps to `EXIT_USAGE_ERROR`.
 *
 * `[paths]` positional filtering (mentioned in PLAN §5 Phase 4's exit
 * criterion prose) is deliberately NOT implemented here — the flag surface
 * PLAN actually enumerates for this phase is `--project`, `--reporter`,
 * `--max-depth`, `--fail-on`, `--ignore`, and per-rule flags, none of which
 * are a bare positional. A stray positional argument is therefore also
 * treated as a usage error rather than silently accepted-and-ignored or
 * silently reinterpreted as a path filter it doesn't implement.
 */

export type OptionalRuleName = 'documented-but-unreachable' | 'unresolvable-status';

const OPTIONAL_RULE_NAMES: readonly OptionalRuleName[] = [
  'documented-but-unreachable',
  'unresolvable-status',
];

function isOptionalRuleName(value: string): value is OptionalRuleName {
  return (OPTIONAL_RULE_NAMES as readonly string[]).includes(value);
}

export interface CliFlags {
  help: boolean;
  project: string | undefined;
  routes: boolean;
  reporter: 'pretty' | 'json' | undefined;
  maxDepth: number | undefined;
  /** Raw `--fail-on` value: `'all'`, `'none'`, or a comma-separated rule list. Parsed in `index.ts`. */
  failOn: string | undefined;
  ignore: string[];
  ignoreStatuses: number[];
  enableRules: OptionalRuleName[];
  disableRules: OptionalRuleName[];
  treatDefaultAsWildcard: boolean | undefined;
  baseDir: string | undefined;
  config: string | undefined;
  noConfig: boolean;
  audit: boolean;
}

export type ParseArgsResult = { ok: true; flags: CliFlags } | { ok: false; error: string };

function emptyFlags(): CliFlags {
  return {
    help: false,
    project: undefined,
    routes: false,
    reporter: undefined,
    maxDepth: undefined,
    failOn: undefined,
    ignore: [],
    ignoreStatuses: [],
    enableRules: [],
    disableRules: [],
    treatDefaultAsWildcard: undefined,
    baseDir: undefined,
    config: undefined,
    noConfig: false,
    audit: false,
  };
}

/** `true` if `value` looks like a flag rather than a value that was meant to follow one. */
function looksLikeFlag(value: string | undefined): boolean {
  return value === undefined || (value.startsWith('-') && value !== '-');
}

/**
 * Same idea as `looksLikeFlag`, but for a value that's expected to be a
 * (possibly negative) number: `-1` must be consumable as `--max-depth`'s or
 * `--ignore-status`'s *value*, not mistaken for the start of the next flag.
 * Pre-Phase-4-review, `--max-depth -1` hit `looksLikeFlag('-1')` first and
 * failed with "requires a value" — the intended "must be a non-negative
 * integer" message a few lines down was unreachable dead code. Only a bare
 * `-` followed immediately by a digit is treated as a value here; `-1abc` or
 * `-x` still read as flags, and the numeric parse a few lines down still
 * rejects anything that isn't actually a valid integer.
 */
function looksLikeNumericFlag(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!value.startsWith('-')) return false;
  return !/^-\d/.test(value);
}

export function parseArgs(argv: string[]): ParseArgsResult {
  const flags = emptyFlags();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const takeValue = (flagName: string): string | { error: string } => {
      const value = argv[i + 1];
      if (looksLikeFlag(value)) {
        return { error: `${flagName} requires a value` };
      }
      i++;
      return value as string;
    };

    /** Like `takeValue`, but doesn't mistake a negative number for a flag — see `looksLikeNumericFlag`. */
    const takeNumericValue = (flagName: string): string | { error: string } => {
      const value = argv[i + 1];
      if (looksLikeNumericFlag(value)) {
        return { error: `${flagName} requires a value` };
      }
      i++;
      return value as string;
    };

    switch (arg) {
      case '--help':
      case '-h':
        flags.help = true;
        break;

      case '--project':
      case '-p': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        flags.project = value;
        break;
      }

      case '--routes':
        flags.routes = true;
        break;

      case '--reporter': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        if (value !== 'pretty' && value !== 'json') {
          return { ok: false, error: `--reporter must be "pretty" or "json", got "${value}"` };
        }
        flags.reporter = value;
        break;
      }

      case '--max-depth': {
        const value = takeNumericValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return {
            ok: false,
            error: `--max-depth must be a non-negative integer, got "${value}"`,
          };
        }
        flags.maxDepth = parsed;
        break;
      }

      case '--fail-on': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        flags.failOn = value;
        break;
      }

      case '--ignore': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        flags.ignore.push(value);
        break;
      }

      case '--ignore-status': {
        const value = takeNumericValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          return { ok: false, error: `--ignore-status must be an integer, got "${value}"` };
        }
        flags.ignoreStatuses.push(parsed);
        break;
      }

      case '--enable-rule':
      case '--disable-rule': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        if (!isOptionalRuleName(value)) {
          return {
            ok: false,
            error:
              `${arg} does not recognize rule "${value}" — expected one of: ` +
              OPTIONAL_RULE_NAMES.join(', '),
          };
        }
        (arg === '--enable-rule' ? flags.enableRules : flags.disableRules).push(value);
        break;
      }

      case '--treat-default-as-wildcard':
        flags.treatDefaultAsWildcard = true;
        break;

      case '--no-treat-default-as-wildcard':
        flags.treatDefaultAsWildcard = false;
        break;

      case '--base-dir': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        flags.baseDir = value;
        break;
      }

      case '--config': {
        const value = takeValue(arg);
        if (typeof value !== 'string') return { ok: false, error: value.error };
        flags.config = value;
        break;
      }

      case '--no-config':
        flags.noConfig = true;
        break;

      case '--audit':
        flags.audit = true;
        break;

      default:
        if (arg.startsWith('-')) {
          return { ok: false, error: `unknown flag: ${arg}` };
        }
        return { ok: false, error: `unexpected argument: ${arg}` };
    }
  }

  return { ok: true, flags };
}
