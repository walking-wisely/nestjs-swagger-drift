import * as ts from 'typescript';
import type { Finding, StatusSource } from './types.js';

export interface TraceHop {
  name: string;
  call: string;
  node: ts.Node;
}

export interface TraceGuard {
  kind:
    | 'if-then'
    | 'if-else'
    | 'conditional-true'
    | 'conditional-false'
    | 'switch-case'
    | 'loop'
    | 'catch';
  condition: string | undefined;
  parameters: string[];
  node: ts.Node;
  assessment: string;
}

export interface TraceArgument {
  parameter: string;
  argument: string;
}

export interface SourceTrace {
  hops: TraceHop[];
  guards: TraceGuard[];
  /** What the last hop passed for each parameter the surviving guards read. */
  finalArguments: TraceArgument[];
}

const MAX_TEXT = 80;

function shortText(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function parameterNames(fn: ts.Node): Set<string> {
  const names = new Set<string>();
  if (!ts.isFunctionLike(fn)) return names;
  for (const param of fn.parameters) {
    if (ts.isIdentifier(param.name)) names.add(param.name.text);
  }
  return names;
}

function referencedParameters(expression: ts.Node, params: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    const isMemberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
    if (ts.isIdentifier(node) && !isMemberName && params.has(node.text)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...found];
}

function assess(parameters: readonly string[]): string {
  if (parameters.length === 0) return 'condition not decidable from literals; assumed reachable';
  return (
    `condition reads parameter ${parameters.join(', ')}, which is not a known constant ` +
    'at the call site; assumed reachable'
  );
}

function guardFor(
  child: ts.Node,
  parent: ts.Node,
  params: ReadonlySet<string>,
): TraceGuard | undefined {
  if (
    ts.isIfStatement(parent) &&
    (child === parent.thenStatement || child === parent.elseStatement)
  ) {
    const parameters = referencedParameters(parent.expression, params);
    return {
      kind: child === parent.thenStatement ? 'if-then' : 'if-else',
      condition: shortText(parent.expression),
      parameters,
      node: parent,
      assessment: assess(parameters),
    };
  }
  if (
    ts.isConditionalExpression(parent) &&
    (child === parent.whenTrue || child === parent.whenFalse)
  ) {
    const parameters = referencedParameters(parent.condition, params);
    return {
      kind: child === parent.whenTrue ? 'conditional-true' : 'conditional-false',
      condition: shortText(parent.condition),
      parameters,
      node: parent,
      assessment: assess(parameters),
    };
  }
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
    const label = ts.isCaseClause(parent) ? shortText(parent.expression) : 'default';
    return {
      kind: 'switch-case',
      condition: label,
      parameters: [],
      node: parent,
      assessment: assess([]),
    };
  }
  if (ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isForStatement(parent)) {
    const condition = ts.isForStatement(parent) ? parent.condition : parent.expression;
    const parameters = condition ? referencedParameters(condition, params) : [];
    return {
      kind: 'loop',
      condition: condition ? shortText(condition) : undefined,
      parameters,
      node: parent,
      assessment: assess(parameters),
    };
  }
  if (ts.isCatchClause(parent)) {
    return {
      kind: 'catch',
      condition: undefined,
      parameters: [],
      node: parent,
      assessment: 'inside a catch block; assumed reachable',
    };
  }
  return undefined;
}

/**
 * Reconstructs why the analyser considered `source` reachable: the call
 * hops that led to it and every enclosing condition between the throw and its
 * function, with how each condition was assessed. Purely descriptive: it
 * re-reads the AST and never changes what is reported.
 */
export function traceSource(source: StatusSource): SourceTrace | undefined {
  if (source.kind === 'implicit') return undefined;

  const hops: TraceHop[] =
    source.kind === 'service-throw'
      ? source.via.map((hop) => ({ name: hop.name, call: shortText(hop.node), node: hop.node }))
      : [];

  let boundary: ts.Node | undefined = source.node.parent;
  while (boundary && !ts.isFunctionLike(boundary)) boundary = boundary.parent;
  const params = boundary ? parameterNames(boundary) : new Set<string>();

  const guards: TraceGuard[] = [];
  let child: ts.Node = source.node;
  for (let node = source.node.parent; node && !ts.isFunctionLike(node); node = node.parent) {
    const guard = guardFor(child, node, params);
    if (guard) guards.push(guard);
    child = node;
  }
  guards.reverse();

  const finalArguments: TraceArgument[] = [];
  const lastCall = hops.length > 0 ? hops[hops.length - 1]!.node : undefined;
  if (boundary && ts.isFunctionLike(boundary) && lastCall && ts.isCallExpression(lastCall)) {
    const wanted = new Set(guards.flatMap((g) => g.parameters));
    const spreadAt = lastCall.arguments.findIndex((a) => ts.isSpreadElement(a));
    boundary.parameters.forEach((param, index) => {
      if (!ts.isIdentifier(param.name) || !wanted.has(param.name.text)) return;
      const arg = lastCall.arguments[index];
      let argument: string;
      if (spreadAt !== -1 && index >= spreadAt) argument = '(spread)';
      else argument = arg === undefined ? '(omitted)' : shortText(arg);
      finalArguments.push({ parameter: param.name.text, argument });
    });
  }
  return { hops, guards, finalArguments };
}

export type Confidence = { level: 'high' } | { level: 'low'; reasons: string[] };

const BARE_TRUTHINESS = /^!?[A-Za-z_$][\w$]*$/;

function lowConfidenceReason(source: StatusSource): string | undefined {
  const trace = traceSource(source);
  if (!trace) return undefined;
  if (trace.guards.some((g) => g.kind === 'catch')) return 'throw inside a catch block';
  if (
    source.kind === 'service-throw' &&
    trace.guards.length > 0 &&
    trace.guards.every(
      (g) =>
        g.kind === 'if-then' &&
        g.parameters.length > 0 &&
        g.condition !== undefined &&
        BARE_TRUTHINESS.test(g.condition),
    )
  ) {
    return 'guard only checks a parameter for emptiness; callers may validate it';
  }
  return undefined;
}

/** Low only when every source of the finding is a throw the analyser reached through a weak signal. */
export function findingConfidence(finding: Finding): Confidence {
  if (finding.rule !== 'undocumented-status' || finding.sources.length === 0) {
    return { level: 'high' };
  }
  const reasons: string[] = [];
  for (const source of finding.sources) {
    const reason = lowConfidenceReason(source);
    if (reason === undefined) return { level: 'high' };
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return { level: 'low', reasons };
}
