/**
 * Statuses documented by project-local decorators that compose or forward to
 * `@nestjs/swagger` response decorators (`applyDecorators(ApiResponse(...))`,
 * `Doc(404)`, ...).
 *
 * A wrapper is read from its source: bodies are interpreted over a small
 * statement subset (`return`, `const`/`let`, assignment, `switch`, `if`) using
 * the call-site constants from `const-eval.ts`. Anything outside that subset
 * (loops, unbound conditions, dynamic spreads) is reported as a gap rather
 * than guessed, so the tool never claims a status it did not prove.
 * `AnalysisOptions.responseDecorators` supplies the statuses of wrappers whose
 * bodies cannot be read.
 */

import * as ts from 'typescript';
import type {
  AnalysisOptions,
  DocumentationGap,
  DocumentedStatusValue,
  StatusRange,
} from './types.js';
import {
  type ArgEnv,
  type EnvValue,
  EMPTY_ENV,
  bindArguments,
  evaluateConst,
  evaluateTruthiness,
  strictEquals,
} from './const-eval.js';
import { checkProvenance } from './provenance.js';
import { SHORTHAND_RESPONSE_DECORATORS } from './nest-exceptions.js';

const SWAGGER_MODULE = '@nestjs/swagger';
const MAX_DEPTH = 8;
const RESPONSE_NAME = /^Api\w*Responses?$/;
const RANGE = /^[1-5]XX$/;

export interface WrapperContext {
  checker: ts.TypeChecker;
  options: AnalysisOptions;
  /** Statuses of a decorator call that genuinely comes from `@nestjs/swagger`. */
  swagger: (effectiveName: string, call: ts.CallExpression) => DocumentedStatusValue[];
}

export interface WrapperResolution {
  statuses: DocumentedStatusValue[];
  gaps: DocumentationGap[];
}

type Signal = 'normal' | 'break' | 'return' | 'opaque';

interface Frame {
  env: Map<string, EnvValue>;
  callables: Map<string, ts.Expression>;
  decorators: Map<string, ts.CallExpression>;
}

interface Output {
  statuses: DocumentedStatusValue[];
  gaps: DocumentationGap[];
  related: boolean;
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

function calleeName(expr: ts.Expression): string | undefined {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function isCallableRef(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  return (
    ts.isIdentifier(node) || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))
  );
}

function locate(node: ts.Node): string {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  const base = file.fileName.split(/[\\/]/).pop() ?? file.fileName;
  return `${base}:${line + 1}`;
}

function mentionsResponseDecorator(fn: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (
        name === 'ApiResponse' ||
        RESPONSE_NAME.test(name) ||
        Object.hasOwn(SHORTHAND_RESPONSE_DECORATORS, name)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

function declarationOf(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.FunctionLikeDeclarationBase | undefined {
  let symbol: ts.Symbol | undefined;
  try {
    symbol = checker.getSymbolAtLocation(unwrap(expr));
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  } catch {
    return undefined;
  }
  for (const decl of symbol?.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) return init;
    }
  }
  return undefined;
}

function rangeOrNumber(value: EnvValue | undefined): DocumentedStatusValue | undefined {
  if (value?.kind === 'number' && Number.isInteger(value.value)) return value.value;
  if (value?.kind === 'string' && RANGE.test(value.value)) return value.value as StatusRange;
  return undefined;
}

function boundStatusOf(call: ts.CallExpression, env: ArgEnv): DocumentedStatusValue | undefined {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const prop of arg.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'status') {
      return rangeOrNumber(evaluateConst(prop.name, env));
    }
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'status' &&
      ts.isIdentifier(unwrap(prop.initializer))
    ) {
      return rangeOrNumber(evaluateConst(prop.initializer, env));
    }
  }
  return undefined;
}

class Interpreter {
  private readonly active = new Set<ts.Node>();

  constructor(
    private readonly ctx: WrapperContext,
    private readonly out: Output,
  ) {}

  private gap(decorator: string, node: ts.Node, reason: string): void {
    this.out.gaps.push({ decorator, reason: `${reason} (${locate(node)})` });
  }

  evalCall(call: ts.CallExpression, frame: Frame, depth: number): void {
    let callee = unwrap(call.expression);
    let name = calleeName(callee);
    if (name === undefined) return;

    if (ts.isIdentifier(callee)) {
      const alias = frame.callables.get(callee.text);
      if (alias) {
        callee = unwrap(alias);
        name = calleeName(callee) ?? name;
      } else if (frame.env.has(callee.text)) {
        return;
      }
    }

    if (name === 'applyDecorators') {
      this.evalArguments(call, frame, depth, name);
      return;
    }

    const provenance = checkProvenance(callee, this.ctx.checker, SWAGGER_MODULE);
    if (provenance.provenance !== 'mismatch') {
      const effective = provenance.resolvedName ?? name;
      this.out.related ||= effective === 'ApiResponse' || RESPONSE_NAME.test(effective);
      const bound = effective === 'ApiResponse' ? boundStatusOf(call, frame.env) : undefined;
      if (bound !== undefined) this.out.statuses.push(bound);
      else this.out.statuses.push(...this.ctx.swagger(effective, call));
      return;
    }

    const configured = this.ctx.options.responseDecorators;
    if (configured && Object.hasOwn(configured, name)) {
      this.out.related = true;
      this.out.statuses.push(...configured[name]!);
      return;
    }

    const fn = declarationOf(callee, this.ctx.checker);
    if (fn) {
      this.evalFunction(fn, call, frame, depth + 1, name);
      return;
    }

    if (RESPONSE_NAME.test(name)) {
      this.out.related = true;
      this.gap(name, call, `cannot read the definition of ${name}`);
    }
  }

  private evalArguments(call: ts.CallExpression, frame: Frame, depth: number, via: string): void {
    for (const arg of call.arguments) {
      const node = unwrap(arg);
      if (ts.isSpreadElement(node)) {
        const inner = unwrap(node.expression);
        if (ts.isArrayLiteralExpression(inner)) {
          for (const element of inner.elements) this.evalDecoratorExpr(element, frame, depth, via);
        } else {
          this.gap(via, node, 'spread of a value that is not an array literal');
        }
        continue;
      }
      this.evalDecoratorExpr(node, frame, depth, via);
    }
  }

  private evalDecoratorExpr(expr: ts.Expression, frame: Frame, depth: number, via: string): void {
    const node = unwrap(expr);
    if (ts.isCallExpression(node)) {
      this.evalCall(node, frame, depth);
    } else if (ts.isIdentifier(node)) {
      const held = frame.decorators.get(node.text);
      if (held) this.evalCall(held, frame, depth);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) this.evalDecoratorExpr(element, frame, depth, via);
    }
  }

  private evalFunction(
    fn: ts.FunctionLikeDeclarationBase,
    call: ts.CallExpression,
    caller: Frame,
    depth: number,
    name: string,
  ): void {
    if (depth > MAX_DEPTH) {
      this.gap(name, call, 'wrapper nesting is too deep to follow');
      return;
    }
    if (this.active.has(fn)) return;
    if (fn.body === undefined) return;

    this.out.related ||= mentionsResponseDecorator(fn.body);
    const env = bindArguments(fn, call, EMPTY_ENV, this.ctx.checker);
    const frame: Frame = {
      env: new Map(env),
      callables: new Map(),
      decorators: new Map(),
    };
    this.active.add(fn);
    try {
      if (ts.isBlock(fn.body)) this.exec(fn.body.statements, frame, depth, name);
      else this.evalDecoratorExpr(fn.body, frame, depth, name);
    } finally {
      this.active.delete(fn);
    }
  }

  private exec(
    statements: readonly ts.Statement[],
    frame: Frame,
    depth: number,
    name: string,
  ): Signal {
    for (const statement of statements) {
      const signal = this.execStatement(statement, frame, depth, name);
      if (signal !== 'normal') return signal;
    }
    return 'normal';
  }

  private forget(frame: Frame, variable: string): void {
    frame.env.delete(variable);
    frame.callables.delete(variable);
    frame.decorators.delete(variable);
  }

  private assign(frame: Frame, variable: string, value: ts.Expression | undefined): void {
    this.forget(frame, variable);
    if (value === undefined) return;
    const constant = evaluateConst(value, frame.env);
    if (constant !== undefined) {
      frame.env.set(variable, constant);
      return;
    }
    const node = unwrap(value);
    if (isCallableRef(node)) frame.callables.set(variable, node);
    else if (ts.isCallExpression(node)) frame.decorators.set(variable, node);
  }

  private execStatement(
    statement: ts.Statement,
    frame: Frame,
    depth: number,
    name: string,
  ): Signal {
    if (ts.isReturnStatement(statement)) {
      if (statement.expression) this.evalDecoratorExpr(statement.expression, frame, depth, name);
      return 'return';
    }
    if (ts.isBreakStatement(statement)) return 'break';
    if (ts.isBlock(statement)) return this.exec(statement.statements, frame, depth, name);

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) this.assign(frame, decl.name.text, decl.initializer);
      }
      return 'normal';
    }

    if (ts.isExpressionStatement(statement)) {
      const expr = unwrap(statement.expression);
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(expr.left))
      ) {
        this.assign(frame, (unwrap(expr.left) as ts.Identifier).text, expr.right);
      }
      return 'normal';
    }

    if (ts.isIfStatement(statement)) {
      const taken = evaluateTruthiness(statement.expression, frame.env);
      if (taken === undefined) {
        this.gap(name, statement, 'if condition is not known at the call site');
        return 'opaque';
      }
      const branch = taken ? statement.thenStatement : statement.elseStatement;
      return branch ? this.execStatement(branch, frame, depth, name) : 'normal';
    }

    if (ts.isSwitchStatement(statement)) return this.execSwitch(statement, frame, depth, name);

    if (
      ts.isForStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isTryStatement(statement)
    ) {
      this.gap(name, statement, 'loop or try block cannot be followed statically');
      return 'opaque';
    }

    return 'normal';
  }

  private execSwitch(
    statement: ts.SwitchStatement,
    frame: Frame,
    depth: number,
    name: string,
  ): Signal {
    const discriminant = evaluateConst(statement.expression, frame.env);
    if (discriminant === undefined) {
      this.gap(name, statement, 'switch on a value not bound at the call site');
      return 'opaque';
    }
    const clauses = statement.caseBlock.clauses;
    let start = -1;
    for (let i = 0; i < clauses.length && start === -1; i++) {
      const clause = clauses[i]!;
      if (!ts.isCaseClause(clause)) continue;
      const value = evaluateConst(clause.expression, frame.env);
      if (value === undefined) {
        this.gap(name, clause, 'switch case is not a constant');
        return 'opaque';
      }
      if (strictEquals(value, discriminant)) start = i;
    }
    if (start === -1) start = clauses.findIndex((clause) => ts.isDefaultClause(clause));
    if (start === -1) return 'normal';

    for (let i = start; i < clauses.length; i++) {
      const signal = this.exec(clauses[i]!.statements, frame, depth, name);
      if (signal === 'break') return 'normal';
      if (signal !== 'normal') return signal;
    }
    return 'normal';
  }
}

/**
 * Statuses documented by the non-`@nestjs/swagger` decorator `decorator`
 * (`@Name(args)`). Returns no statuses and no gaps for decorators that have
 * nothing to do with responses.
 */
export function resolveWrapperDecorator(
  decorator: ts.Decorator,
  name: string,
  ctx: WrapperContext,
): WrapperResolution {
  const expression = unwrap(decorator.expression);
  if (!ts.isCallExpression(expression)) return { statuses: [], gaps: [] };

  const out: Output = { statuses: [], gaps: [], related: RESPONSE_NAME.test(name) };
  const frame: Frame = { env: new Map(), callables: new Map(), decorators: new Map() };
  new Interpreter(ctx, out).evalCall(expression, frame, 0);
  return { statuses: out.statuses, gaps: out.related ? dedupe(out.gaps, name) : [] };
}

function dedupe(gaps: DocumentationGap[], name: string): DocumentationGap[] {
  const seen = new Set<string>();
  const result: DocumentationGap[] = [];
  for (const gap of gaps) {
    const key = gap.reason;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ decorator: name, reason: gap.reason });
  }
  return result;
}
