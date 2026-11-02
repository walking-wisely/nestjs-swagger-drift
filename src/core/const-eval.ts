import * as ts from 'typescript';

export type ConstValue =
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'truthy' };

/** A parameter whose value is unknown but whose runtime `typeof` is always one of `types`. */
export interface TypeofFact {
  kind: 'typeof';
  types: readonly string[];
}

export type EnvValue = ConstValue | TypeofFact;

/** Parameter name to what every caller on the current path is known to pass. */
export type ArgEnv = ReadonlyMap<string, EnvValue>;

export const EMPTY_ENV: ArgEnv = new Map();

const UNDEFINED: ConstValue = { kind: 'undefined' };
const TRUTHY: ConstValue = { kind: 'truthy' };

const CALL_KEY_PREFIX = 'call:';

/** Env key for a call whose result a guard guarantees to be truthy: `Recv.method` or a bare `fn`. */
export function callKeyFor(callee: ts.Expression): string | undefined {
  const node = unwrap(callee);
  if (ts.isIdentifier(node)) return `${CALL_KEY_PREFIX}${node.text}`;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const receiver = node.expression;
    if (ts.isIdentifier(receiver)) return `${CALL_KEY_PREFIX}${receiver.text}.${node.name.text}`;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword)
      return `${CALL_KEY_PREFIX}this.${node.name.text}`;
  }
  return undefined;
}

export function guaranteeEnv(accessors: readonly string[]): ArgEnv {
  const env = new Map<string, EnvValue>();
  for (const accessor of accessors) env.set(`${CALL_KEY_PREFIX}${accessor}`, TRUTHY);
  return env;
}

function guaranteesOf(env: ArgEnv): [string, EnvValue][] {
  return [...env].filter(([key]) => key.startsWith(CALL_KEY_PREFIX));
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function evaluateConst(expr: ts.Expression, env: ArgEnv): ConstValue | undefined {
  const node = unwrap(expr);
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return { kind: 'bool', value: true };
    case ts.SyntaxKind.FalseKeyword:
      return { kind: 'bool', value: false };
    case ts.SyntaxKind.NullKeyword:
      return { kind: 'null' };
  }
  if (ts.isNumericLiteral(node)) return { kind: 'number', value: Number(node.text) };
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', value: node.text };
  }
  if (ts.isIdentifier(node)) {
    const bound = env.get(node.text);
    return bound === undefined || bound.kind === 'typeof' ? undefined : bound;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evaluateTruthiness(node.operand, env);
    return inner === undefined ? undefined : { kind: 'bool', value: !inner };
  }
  if (ts.isCallExpression(node) && !node.questionDotToken) {
    const key = callKeyFor(node.expression);
    const known = key === undefined ? undefined : env.get(key);
    return known?.kind === 'truthy' ? known : undefined;
  }
  if (ts.isAwaitExpression(node)) return evaluateConst(node.expression, env);
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const left = evaluateConst(node.left, env);
      if (left === undefined) return undefined;
      const keepLeft =
        op === ts.SyntaxKind.BarBarToken
          ? truthiness(left)
          : left.kind !== 'null' && left.kind !== 'undefined';
      return keepLeft ? left : evaluateConst(node.right, env);
    }
  }
  return undefined;
}

function truthiness(value: ConstValue): boolean {
  switch (value.kind) {
    case 'bool':
      return value.value;
    case 'truthy':
      return true;
    case 'number':
      return value.value !== 0 && !Number.isNaN(value.value);
    case 'string':
      return value.value.length > 0;
    default:
      return false;
  }
}

function isUnboundUndefinedIdentifier(node: ts.Expression): boolean {
  return ts.isIdentifier(unwrap(node)) && (unwrap(node) as ts.Identifier).text === 'undefined';
}

function strictEquals(a: ConstValue, b: ConstValue): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'null' || a.kind === 'undefined') return true;
  return (a as { value: unknown }).value === (b as { value: unknown }).value;
}

/**
 * `true`/`false` only when `expr`'s truthiness is fully determined by literals
 * and bound parameters; `undefined` for anything else. Never guesses.
 */
export function evaluateTruthiness(expr: ts.Expression, env: ArgEnv): boolean | undefined {
  const node = unwrap(expr);

  if (isUnboundUndefinedIdentifier(node) && !env.has('undefined')) return false;

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const left = evaluateTruthiness(node.left, env);
      const right = evaluateTruthiness(node.right, env);
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
      return undefined;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const left = evaluateTruthiness(node.left, env);
      const right = evaluateTruthiness(node.right, env);
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
      return undefined;
    }
    const typeofResult = evaluateTypeofComparison(node, env);
    if (typeofResult !== undefined) return typeofResult;
    const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const isStrictNe = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
    const isLooseNe = op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isStrictEq || isStrictNe || isLooseEq || isLooseNe) {
      const left = isUnboundUndefinedIdentifier(node.left)
        ? UNDEFINED
        : evaluateConst(node.left, env);
      const right = isUnboundUndefinedIdentifier(node.right)
        ? UNDEFINED
        : evaluateConst(node.right, env);
      if (left === undefined || right === undefined) return undefined;
      if (left.kind === 'truthy' || right.kind === 'truthy') {
        const other = left.kind === 'truthy' ? right : left;
        if (other.kind !== 'null' && other.kind !== 'undefined') return undefined;
        return isStrictNe || isLooseNe;
      }
      const nullish = (v: ConstValue): boolean => v.kind === 'null' || v.kind === 'undefined';
      let equal: boolean;
      if ((isLooseEq || isLooseNe) && (nullish(left) || nullish(right))) {
        equal = nullish(left) && nullish(right);
      } else if (isLooseEq || isLooseNe) {
        if (left.kind !== right.kind) return undefined;
        equal = strictEquals(left, right);
      } else {
        equal = strictEquals(left, right);
      }
      return isStrictEq || isLooseEq ? equal : !equal;
    }
    return undefined;
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evaluateTruthiness(node.operand, env);
    return inner === undefined ? undefined : !inner;
  }

  const value = evaluateConst(node, env);
  return value === undefined ? undefined : truthiness(value);
}

function typeofFactOf(expr: ts.Expression, env: ArgEnv): TypeofFact | undefined {
  const node = unwrap(expr);
  if (!ts.isTypeOfExpression(node)) return undefined;
  const operand = unwrap(node.expression);
  if (!ts.isIdentifier(operand)) return undefined;
  const bound = env.get(operand.text);
  return bound?.kind === 'typeof' ? bound : undefined;
}

function evaluateTypeofComparison(node: ts.BinaryExpression, env: ArgEnv): boolean | undefined {
  const op = node.operatorToken.kind;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNe =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNe) return undefined;
  const leftFact = typeofFactOf(node.left, env);
  const rightFact = typeofFactOf(node.right, env);
  const fact = leftFact ?? rightFact;
  if (fact === undefined) return undefined;
  const other = evaluateConst(leftFact ? node.right : node.left, env);
  if (other?.kind !== 'string') return undefined;
  if (!fact.types.includes(other.value)) return isEq ? false : true;
  return fact.types.length === 1 ? isEq : undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * Parameters of `fn` that may safely be treated as constants for one call:
 * plain identifier parameters that are never reassigned or re-declared in the
 * body.
 */
export function bindableParameters(fn: ts.FunctionLikeDeclarationBase): Map<number, string> {
  const candidates = new Map<string, number>();
  fn.parameters.forEach((param, index) => {
    if (ts.isIdentifier(param.name) && param.dotDotDotToken === undefined)
      candidates.set(param.name.text, index);
  });
  if (candidates.size === 0 || fn.body === undefined) return new Map();

  const unsafe = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperator(node.operatorToken.kind) &&
      ts.isIdentifier(unwrap(node.left))
    ) {
      unsafe.add((unwrap(node.left) as ts.Identifier).text);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      unsafe.add(node.operand.text);
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name)
    ) {
      unsafe.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) unsafe.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);

  const result = new Map<number, string>();
  for (const [name, index] of candidates) if (!unsafe.has(name)) result.set(index, name);
  return result;
}

/**
 * The constants a callee can rely on, given the arguments at `callNode` as
 * seen from a caller whose own bindings are `callerEnv`. An argument that is
 * not a known constant leaves its parameter unbound.
 */
export function bindArguments(
  callee: ts.FunctionLikeDeclarationBase,
  callNode: ts.Node,
  callerEnv: ArgEnv,
  checker?: ts.TypeChecker,
): ArgEnv {
  if (!ts.isCallExpression(callNode)) {
    const carried = guaranteesOf(callerEnv);
    return carried.length === 0 ? EMPTY_ENV : new Map(carried);
  }
  const bindable = bindableParameters(callee);
  const env = new Map<string, EnvValue>(guaranteesOf(callerEnv));
  if (bindable.size === 0) return env.size === 0 ? EMPTY_ENV : env;

  const args = callNode.arguments;
  const spreadAt = args.findIndex((a) => ts.isSpreadElement(a));

  for (const [index, name] of bindable) {
    if (spreadAt !== -1 && index >= spreadAt) continue;
    const param = callee.parameters[index]!;
    const arg = args[index];
    let value: EnvValue | undefined;
    if (arg === undefined) {
      value = param.initializer ? evaluateConst(param.initializer, EMPTY_ENV) : UNDEFINED;
    } else {
      value = isUnboundUndefinedIdentifier(arg) ? UNDEFINED : evaluateConst(arg, callerEnv);
      if (value?.kind === 'undefined' && param.initializer) {
        value = evaluateConst(param.initializer, EMPTY_ENV);
      }
      if (value === undefined) value = forwardedOrDeclaredTypeof(arg, callerEnv, checker);
    }
    if (value !== undefined) env.set(name, value);
  }
  return env;
}

function forwardedOrDeclaredTypeof(
  arg: ts.Expression,
  callerEnv: ArgEnv,
  checker: ts.TypeChecker | undefined,
): TypeofFact | undefined {
  const node = unwrap(arg);
  if (ts.isIdentifier(node)) {
    const bound = callerEnv.get(node.text);
    if (bound?.kind === 'typeof') return bound;
  }
  if (checker === undefined) return undefined;
  const types = typeofSetOf(checker.getTypeAtLocation(arg));
  return types === undefined ? undefined : { kind: 'typeof', types };
}

function typeofSetOf(type: ts.Type): string[] | undefined {
  const parts = type.isUnion() ? type.types : [type];
  const found = new Set<string>();
  for (const part of parts) {
    const flags = part.flags;
    if (flags & ts.TypeFlags.StringLike) found.add('string');
    else if (flags & ts.TypeFlags.NumberLike) found.add('number');
    else if (flags & ts.TypeFlags.BooleanLike) found.add('boolean');
    else if (flags & ts.TypeFlags.BigIntLike) found.add('bigint');
    else if (flags & ts.TypeFlags.ESSymbolLike) found.add('symbol');
    else if (flags & ts.TypeFlags.Undefined) found.add('undefined');
    else if (flags & ts.TypeFlags.Null) found.add('object');
    else if (flags & ts.TypeFlags.Object) {
      found.add(part.getCallSignatures().length > 0 ? 'function' : 'object');
    } else return undefined;
  }
  return found.size === 0 ? undefined : [...found].sort();
}

const usedNames = new WeakMap<ts.Node, Set<string>>();

function identifiersUsedIn(fn: ts.FunctionLikeDeclarationBase): Set<string> {
  let names = usedNames.get(fn);
  if (!names) {
    names = new Set();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) names!.add(node.text);
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    usedNames.set(fn, names);
  }
  return names;
}

/** Cache key for `env` restricted to the bindings `fn` actually mentions; `''` when none apply. */
export function envKeyFor(fn: ts.FunctionLikeDeclarationBase, env: ArgEnv): string {
  if (env.size === 0) return '';
  const used = identifiersUsedIn(fn);
  const parts: string[] = [];
  for (const [name, value] of env) {
    if (!used.has(name) && !name.startsWith(CALL_KEY_PREFIX)) continue;
    parts.push(
      `${name}=${value.kind}:${value.kind === 'typeof' ? value.types.join('|') : 'value' in value ? String(value.value) : ''}`,
    );
  }
  return parts.sort().join(',');
}

export function restrictEnv(fn: ts.FunctionLikeDeclarationBase, env: ArgEnv): ArgEnv {
  if (env.size === 0) return env;
  const used = identifiersUsedIn(fn);
  const kept = new Map<string, EnvValue>();
  for (const [name, value] of env) {
    if (used.has(name) || name.startsWith(CALL_KEY_PREFIX)) kept.set(name, value);
  }
  return kept;
}

const localConstCandidates = new WeakMap<ts.Node, { name: string; init: ts.Expression }[]>();

function localConstsOf(
  fn: ts.FunctionLikeDeclarationBase,
): { name: string; init: ts.Expression }[] {
  const cached = localConstCandidates.get(fn);
  if (cached) return cached;
  const declarations = new Map<string, number>();
  const bump = (name: string): void => {
    declarations.set(name, (declarations.get(name) ?? 0) + 1);
  };
  for (const param of fn.parameters) {
    if (ts.isIdentifier(param.name)) bump(param.name.text);
  }
  const consts: { name: string; init: ts.Expression }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node)) {
      if (ts.isIdentifier(node.name)) {
        bump(node.name.text);
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          ts.isVariableDeclarationList(node.parent) &&
          node.parent.flags & ts.NodeFlags.Const
        ) {
          consts.push({ name: node.name.text, init: node.initializer });
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) bump(node.name.text);
    ts.forEachChild(node, visit);
  };
  if (fn.body) ts.forEachChild(fn.body, visit);
  const result = consts.filter((c) => declarations.get(c.name) === 1);
  localConstCandidates.set(fn, result);
  return result;
}

/** `env` plus every `const` local of `fn` whose initializer is decided by `env` alone. */
export function withLocalConsts(fn: ts.FunctionLikeDeclarationBase, env: ArgEnv): ArgEnv {
  const candidates = localConstsOf(fn);
  if (candidates.length === 0) return env;
  let extended: Map<string, EnvValue> | undefined;
  for (const { name, init } of candidates) {
    const scope = extended ?? env;
    if (scope.has(name)) continue;
    const value = evaluateConst(init, scope);
    if (value === undefined) continue;
    extended ??= new Map(env);
    extended.set(name, value);
  }
  return extended ?? env;
}
