/**
 * Pure path-joining for routes: `@Controller` prefix + handler-decorator
 * segment → the `path` reported on `HandlerInfo`.
 *
 * Deliberately hand-rolled string manipulation rather than `node:path`
 * (which is POSIX/Windows-aware, not URL-aware, and forbidden in `core/`
 * per PLAN.md §3 anyway).
 */

/**
 * Joins a class-level path prefix and a method-level path segment into a
 * single route path with exactly one leading slash, no trailing slash
 * (unless the result is the root `/`), and no duplicate/empty internal
 * slashes — regardless of how the inputs were written.
 *
 * Examples:
 * - `joinPath('users', ':id')`      → `/users/:id`
 * - `joinPath('', '')`              → `/`
 * - `joinPath('/users/', '/:id/')`  → `/users/:id`
 * - `joinPath('users', '')`         → `/users`
 * - `joinPath('', 'health')`        → `/health`
 *
 * One deliberate divergence from real NestJS routing: for a doubled internal
 * slash like `joinPath('users//', '//:id')`, NestJS's own path-to-regexp
 * layer would register the literal `/users///:id` (it does not collapse
 * internal empty segments). This function collapses them to `/users/:id`
 * instead. That's an intentional choice, not an oversight — a doubled slash
 * is virtually always a typo, not an intentional path segment, and
 * collapsing gives a more useful (and still stable/deterministic) route
 * table for a case that would otherwise just look broken either way.
 */
export function joinPath(classPath: string, methodPath: string): string {
  const segments = [classPath, methodPath]
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}
