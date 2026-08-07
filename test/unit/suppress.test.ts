import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  isStatusSuppressed,
  checkHandlerSuppression,
  checkSourceSuppression,
  listDirectiveCommentLines,
} from '../../src/core/suppress.js';
import { createInMemoryProgram } from '../helpers/in-memory-program.js';

function findThrowStatements(sourceFile: ts.SourceFile): ts.ThrowStatement[] {
  const results: ts.ThrowStatement[] = [];
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isThrowStatement(node)) results.push(node);
    ts.forEachChild(node, visit);
  });
  return results;
}

function nthThrow(sourceFile: ts.SourceFile, index: number): ts.ThrowStatement {
  const throwStatement = findThrowStatements(sourceFile)[index];
  if (!throwStatement) throw new Error(`no throw statement at index ${index}`);
  return throwStatement;
}

function findMethod(sourceFile: ts.SourceFile, name: string): ts.MethodDeclaration {
  let found: ts.MethodDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText() === name) found = node;
    ts.forEachChild(node, visit);
  });
  if (!found) throw new Error(`method ${name} not found`);
  return found;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  experimentalDecorators: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

describe('isStatusSuppressed', () => {
  it('is false with no comment at all (non-vacuous baseline)', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(false);
  });

  it('a bare disable-next-line suppresses every status at that line', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            // swagger-drift-disable-next-line
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(true);
    expect(isStatusSuppressed(throwStatement, 500)).toBe(true);
  });

  it('a disable-next-line with a status list only suppresses the listed statuses', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            // swagger-drift-disable-next-line 404, 409
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(true);
    expect(isStatusSuppressed(throwStatement, 409)).toBe(true);
    expect(isStatusSuppressed(throwStatement, 500)).toBe(false);
  });

  it('does not suppress when the comment is not directly adjacent (a blank line between)', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            // swagger-drift-disable-next-line 404

            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(false);
  });

  it('does not suppress an unrelated throw elsewhere in the same file', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            // swagger-drift-disable-next-line 404
            throw new Error('a');
          }
          function g() {
            throw new Error('b');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const suppressed = nthThrow(sourceFile, 0);
    const unrelated = nthThrow(sourceFile, 1);
    expect(isStatusSuppressed(suppressed, 404)).toBe(true);
    expect(isStatusSuppressed(unrelated, 404)).toBe(false);
  });

  it('a directive directly above a decorated method suppresses at the method (handler) level', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function Get(): MethodDecorator {
            return () => undefined;
          }
          class C {
            // swagger-drift-disable-next-line 404
            @Get()
            findOne() {
              return 1;
            }

            findTwo() {
              return 2;
            }
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const findOne = findMethod(sourceFile, 'findOne');
    const findTwo = findMethod(sourceFile, 'findTwo');
    expect(isStatusSuppressed(findOne, 404)).toBe(true);
    expect(isStatusSuppressed(findTwo, 404)).toBe(false);
  });

  it('/* */ block comments are recognized, not only //', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            /* swagger-drift-disable-next-line 404 */
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(true);
  });

  // Phase 4 review, finding S3: the directive regex used `.`, which doesn't
  // cross newlines, so a multi-line block comment's status list was
  // invisible and silently fell through to "suppress everything."
  it('a status list pushed to a continuation line of a multi-line block comment is still parsed (Phase 4 review, finding S3)', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            /* swagger-drift-disable-next-line
               409 */
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    // Non-vacuous: this must suppress ONLY 409, not "everything" — 404
    // staying unsuppressed is exactly what the pre-fix `.`-based regex got
    // wrong (it fell through to `{ statuses: 'all' }`).
    expect(isStatusSuppressed(throwStatement, 409)).toBe(true);
    expect(isStatusSuppressed(throwStatement, 404)).toBe(false);
  });

  // Phase 4 review, finding S4: the status list used to be scanned for via
  // `matchAll(/\d+/g)` over the whole rest of the comment, picking up any
  // digit run anywhere — including a ticket reference in trailing prose, or
  // (in the other direction) missing that trailing prose with no digits at
  // all means "suppress everything," not "suppress nothing."
  describe('the status list is anchored to the start of the line, not scanned for anywhere (Phase 4 review, finding S4)', () => {
    it('trailing prose with an unrelated number is not mistaken for a second status', () => {
      const program = createInMemoryProgram(
        {
          'main.ts': `
            function f() {
              // swagger-drift-disable-next-line 404 (see ticket 409)
              throw new Error('x');
            }
          `,
        },
        ['main.ts'],
        COMPILER_OPTIONS,
      );
      const sourceFile = program.getSourceFile('main.ts');
      if (!sourceFile) throw new Error('missing main.ts');
      const throwStatement = nthThrow(sourceFile, 0);
      expect(isStatusSuppressed(throwStatement, 404)).toBe(true);
      expect(isStatusSuppressed(throwStatement, 409)).toBe(false);
    });

    it('trailing prose with no status list at all means "suppress everything," not "suppress the ticket number"', () => {
      const program = createInMemoryProgram(
        {
          'main.ts': `
            function f() {
              // swagger-drift-disable-next-line -- tracked in JIRA-409
              throw new Error('x');
            }
          `,
        },
        ['main.ts'],
        COMPILER_OPTIONS,
      );
      const sourceFile = program.getSourceFile('main.ts');
      if (!sourceFile) throw new Error('missing main.ts');
      const throwStatement = nthThrow(sourceFile, 0);
      expect(isStatusSuppressed(throwStatement, 409)).toBe(true);
      expect(isStatusSuppressed(throwStatement, 500)).toBe(true);
    });
  });
});

describe('checkHandlerSuppression (Phase 4 review, finding S5)', () => {
  it('a directive between the last decorator and the method name suppresses at the method (handler) level', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function Get(): MethodDecorator {
            return () => undefined;
          }
          class C {
            @Get()
            // swagger-drift-disable-next-line 404
            findOne() {
              return 1;
            }

            findTwo() {
              return 2;
            }
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const findOne = findMethod(sourceFile, 'findOne');
    const findTwo = findMethod(sourceFile, 'findTwo');
    // Non-vacuous: pre-fix, `isStatusSuppressed(findOne, 404)` alone (the
    // method-declaration-only check) was `false` here — the comment sits
    // between the decorator and the name, nobody's leading trivia at the
    // method-declaration level.
    expect(isStatusSuppressed(findOne, 404)).toBe(false);
    expect(checkHandlerSuppression(findOne, 404).suppressed).toBe(true);
    expect(checkHandlerSuppression(findTwo, 404).suppressed).toBe(false);
  });
});

describe('listDirectiveCommentLines', () => {
  it('finds a real directive line', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            // swagger-drift-disable-next-line 404
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    expect(listDirectiveCommentLines(sourceFile)).toEqual([3]);
  });

  // Found via manual end-to-end smoke testing of the built CLI: a doc
  // comment that merely *mentions* the directive by name in prose (exactly
  // what this repo's own fixtures do, describing the feature) must not be
  // reported as "a directive that suppressed nothing" — that's a false
  // positive that would make the diagnostic noisy on any codebase whose
  // documentation talks about the feature at all.
  it('does not mistake prose merely mentioning the directive by name for a real directive', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          // See the swagger-drift-disable-next-line directive for details.
          function f() {
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    expect(listDirectiveCommentLines(sourceFile)).toEqual([]);
  });

  it('recognizes a directive on its own line even mid-comment-block (leading `*` continuation)', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f() {
            /**
             * swagger-drift-disable-next-line 404
             */
            throw new Error('x');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    expect(listDirectiveCommentLines(sourceFile)).toEqual([4]);
  });
});

describe('checkSourceSuppression (Phase 4 review, finding S5)', () => {
  it('a directive above an unbraced `if (!x) throw ...;` suppresses the throw inside it', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f(x: unknown) {
            // swagger-drift-disable-next-line 404
            if (!x) throw new Error('not found');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const throwStatement = nthThrow(sourceFile, 0);
    // Non-vacuous: pre-fix, `isStatusSuppressed(throwStatement, 404)` alone
    // was `false` — the comment is the `IfStatement`'s leading trivia, not
    // the nested `ThrowStatement`'s, for this "the ubiquitous idiom" case.
    expect(isStatusSuppressed(throwStatement, 404)).toBe(false);
    expect(checkSourceSuppression(throwStatement, 404).suppressed).toBe(true);
  });

  it('does not reach past the enclosing statement to suppress an unrelated throw two statements up', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f(x: unknown, y: unknown) {
            // swagger-drift-disable-next-line 404
            if (!x) throw new Error('a');
            if (!y) throw new Error('b');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const suppressed = nthThrow(sourceFile, 0);
    const unrelated = nthThrow(sourceFile, 1);
    expect(checkSourceSuppression(suppressed, 404).suppressed).toBe(true);
    expect(checkSourceSuppression(unrelated, 404).suppressed).toBe(false);
  });

  it('#16: a directive above the first branch of an unbraced if/else-if chain does not suppress a later branch', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f(x: unknown, y: unknown) {
            // swagger-drift-disable-next-line 404
            if (!x) throw new Error('not found');
            else if (!y) throw new Error('conflict');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const suppressed = nthThrow(sourceFile, 0);
    const unrelated = nthThrow(sourceFile, 1);
    expect(checkSourceSuppression(suppressed, 404).suppressed).toBe(true);
    // Pre-fix, this was `true` too: the walk climbed straight past the
    // `else if`'s own `IfStatement` up to the outermost one, which is where
    // the directive's leading trivia actually lives.
    expect(checkSourceSuppression(unrelated, 404).suppressed).toBe(false);
  });

  it('#16: a directive above a later `else`/`if` branch suppresses only that branch', () => {
    const program = createInMemoryProgram(
      {
        'main.ts': `
          function f(x: unknown, y: unknown) {
            if (!x) throw new Error('not found');
            else
            // swagger-drift-disable-next-line 409
            if (!y) throw new Error('conflict');
          }
        `,
      },
      ['main.ts'],
      COMPILER_OPTIONS,
    );
    const sourceFile = program.getSourceFile('main.ts');
    if (!sourceFile) throw new Error('missing main.ts');
    const firstBranch = nthThrow(sourceFile, 0);
    const secondBranch = nthThrow(sourceFile, 1);
    expect(checkSourceSuppression(firstBranch, 409).suppressed).toBe(false);
    expect(checkSourceSuppression(secondBranch, 409).suppressed).toBe(true);
  });
});
