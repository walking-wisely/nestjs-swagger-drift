import { describe, expect, it } from 'vitest';
import {
  blockingReasons,
  buildVerdictFile,
  computeDelta,
  fingerprint,
  groupClasses,
  rebaseline,
  rollupSites,
  type RunFinding,
} from '../../scripts/corpus/lib.ts';

function finding(overrides: Partial<RunFinding> = {}): RunFinding {
  return {
    rule: 'undocumented-status',
    status: 404,
    handler: {
      className: 'UsersController',
      methodName: 'findOne',
      location: { file: 'src/users.controller.ts' },
    },
    sources: [{ kind: 'throw', exception: 'NotFoundException' }],
    ...overrides,
  };
}

describe('corpus fingerprint', () => {
  it('survives an unrelated edit that shifts every line number', () => {
    const before = finding({
      handler: {
        className: 'UsersController',
        methodName: 'findOne',
        location: { file: 'src/users.controller.ts', line: 20 },
      },
      location: { file: 'src/users.controller.ts', line: 22 },
      sources: [
        {
          kind: 'service-throw',
          exception: 'NotFoundException',
          via: ['UsersService.find'],
          location: { file: 'src/users.service.ts', line: 40 },
        },
      ],
    });
    const after = finding({
      handler: {
        className: 'UsersController',
        methodName: 'findOne',
        location: { file: 'src/users.controller.ts', line: 27 },
      },
      location: { file: 'src/users.controller.ts', line: 29 },
      sources: [
        {
          kind: 'service-throw',
          exception: 'NotFoundException',
          via: ['UsersService.find'],
          location: { file: 'src/users.service.ts', line: 52 },
        },
      ],
    });
    expect(fingerprint(after)).toBe(fingerprint(before));
    expect(
      computeDelta({ [fingerprint(before)]: { verdict: 'TP', key: 'k' } }, [after]),
    ).toMatchObject({
      added: [],
      disappeared: [],
      changed: [],
    });
  });

  it('ignores source ordering', () => {
    const a = finding({
      sources: [
        { kind: 'throw', exception: 'A' },
        { kind: 'throw', exception: 'B' },
      ],
    });
    const b = finding({
      sources: [
        { kind: 'throw', exception: 'B' },
        { kind: 'throw', exception: 'A' },
      ],
    });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when the source set changes', () => {
    const a = finding();
    const b = finding({
      sources: [{ kind: 'service-throw', exception: 'NotFoundException', via: ['svc.get'] }],
    });
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('corpus delta', () => {
  const base = finding();
  const baseline = buildVerdictFile('sha', '0.0.0', '2026-01-01', [base]).entries;

  it('reports an identical run as unchanged', () => {
    const delta = computeDelta(baseline, [base]);
    expect(delta.unchanged).toHaveLength(1);
    expect(blockingReasons(delta)).toEqual([]);
  });

  it('reports a new finding as blocking', () => {
    const extra = finding({ status: 409 });
    const delta = computeDelta(baseline, [base, extra]);
    expect(delta.added).toHaveLength(1);
    expect(blockingReasons(delta)).toHaveLength(1);
  });

  it('reports a lost finding as blocking unless it was a known FP', () => {
    const lost = computeDelta(baseline, []);
    expect(lost.disappeared).toHaveLength(1);
    expect(blockingReasons(lost)).toHaveLength(1);

    const fpBaseline = Object.fromEntries(
      Object.entries(baseline).map(([fp, e]) => [fp, { ...e, verdict: 'FP' as const }]),
    );
    expect(blockingReasons(computeDelta(fpBaseline, []))).toEqual([]);
  });

  it('pairs a source-set change into a single changed entry', () => {
    const rewritten = finding({ sources: [{ kind: 'implicit', reason: 'validation-pipe' }] });
    const delta = computeDelta(baseline, [rewritten]);
    expect(delta.changed).toHaveLength(1);
    expect(delta.added).toHaveLength(0);
    expect(delta.disappeared).toHaveLength(0);
  });
});

describe('corpus classes', () => {
  it('groups findings that differ only by handler into one class', () => {
    const a = finding();
    const b = finding({
      handler: {
        className: 'OrdersController',
        methodName: 'get',
        location: { file: 'src/orders.controller.ts' },
      },
    });
    const c = finding({ status: 409 });
    const classes = groupClasses([a, b, c]);
    expect(classes.map((x) => x.count)).toEqual([2, 1]);
    expect(classes[0]!.files).toBe(2);
    expect(classes[0]!.fingerprints).toHaveLength(2);
  });

  it('groups by throw site regardless of call depth', () => {
    const site = { file: 'ctx.ts', line: 417 };
    const shallow = finding({
      sources: [{ kind: 'service-throw', exception: 'X', via: ['a'], location: site }],
    });
    const deep = finding({
      sources: [{ kind: 'service-throw', exception: 'X', via: ['a', 'b', 'c'], location: site }],
    });
    const other = finding({
      sources: [
        {
          kind: 'service-throw',
          exception: 'X',
          via: ['a'],
          location: { file: 'ctx.ts', line: 482 },
        },
      ],
    });
    const classes = groupClasses([shallow, deep, other]);
    expect(classes.map((c) => c.count)).toEqual([2, 1]);
  });

  it('samples every distinct immediate caller plus the deepest chain', () => {
    const site = { file: 'ctx.ts', line: 417 };
    const make = (via: string[], i: number) =>
      finding({
        handler: { className: 'C', methodName: `m${i}`, location: { file: `f${i}.ts` } },
        sources: [{ kind: 'service-throw', exception: 'X', via, location: site }],
      });
    const members = [
      make(['a', 'leaf'], 0),
      make(['b', 'leaf'], 1),
      make(['a', 'b', 'c', 'leaf'], 2),
    ];
    const [cls] = groupClasses(members, 3);
    expect(cls!.callers).toBe(3);
    expect(cls!.samples).toHaveLength(3);
  });

  it('never samples more than requested', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      finding({ handler: { className: 'C', methodName: `m${i}`, location: { file: `f${i}.ts` } } }),
    );
    expect(groupClasses(many, 3)[0]!.samples).toHaveLength(3);
  });
});

describe('corpus site rollup', () => {
  it('counts a multi-site finding once under each site', () => {
    const a = { file: 'ctx.ts', line: 1 };
    const b = { file: 'ctx.ts', line: 2 };
    const both = finding({
      sources: [
        { kind: 'service-throw', exception: 'X', via: ['p', 'q'], location: a },
        { kind: 'service-throw', exception: 'X', via: ['p', 'r'], location: b },
      ],
    });
    const onlyA = finding({
      handler: { className: 'C', methodName: 'z', location: { file: 'z.ts' } },
      sources: [{ kind: 'service-throw', exception: 'X', via: ['p', 'q'], location: a }],
    });
    const rollup = rollupSites([both, onlyA]);
    expect(rollup.map((r) => r.findings)).toEqual([2, 1]);
  });
});

describe('corpus rebaseline', () => {
  const kept = finding();
  const gone = finding({ status: 409 });
  const seed = buildVerdictFile('sha', '0.0.0', '2026-01-01', [kept, gone]);

  it('refuses when a finding is new', () => {
    const result = rebaseline(seed, [kept, gone, finding({ status: 500 })], '1', 'd', true);
    expect(result.file).toBeUndefined();
  });

  it('refuses to drop an unreviewed finding unless told to', () => {
    expect(rebaseline(seed, [kept], '1', 'd', false).file).toBeUndefined();
    expect(Object.keys(rebaseline(seed, [kept], '1', 'd', true).file!.entries)).toEqual([
      fingerprint(kept),
    ]);
  });

  it('drops a known false positive and refuses to drop a true positive', () => {
    const fpKey = fingerprint(gone);
    const withFp = {
      ...seed,
      entries: { ...seed.entries, [fpKey]: { ...seed.entries[fpKey]!, verdict: 'FP' as const } },
    };
    expect(rebaseline(withFp, [kept], '1', 'd', false).file).toBeDefined();
    const withTp = {
      ...seed,
      entries: { ...seed.entries, [fpKey]: { ...seed.entries[fpKey]!, verdict: 'TP' as const } },
    };
    expect(rebaseline(withTp, [kept], '1', 'd', true).file).toBeUndefined();
  });

  it('carries a verdict across a changed source set', () => {
    const fpKey = fingerprint(kept);
    const verdicted = {
      ...seed,
      entries: { ...seed.entries, [fpKey]: { ...seed.entries[fpKey]!, verdict: 'TP' as const } },
    };
    const rewritten = finding({ sources: [{ kind: 'implicit', reason: 'x' }] });
    const result = rebaseline(verdicted, [rewritten, gone], '1', 'd', false);
    expect(result.file!.entries[fingerprint(rewritten)]!.verdict).toBe('TP');
  });
});
