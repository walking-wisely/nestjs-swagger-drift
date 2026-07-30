# Publishing

Not published yet — `package.json` has `"private": true` deliberately. Per
PLAN.md §5, that's a Phase 5 exit criterion (v0.1.0 to npm), not a Phase 0
concern. This file exists so that constraint doesn't get lost as an implicit
assumption between now and then.

Before publishing, `package.json` needs:

- Remove `"private": true`.
- Add `"repository"`, `"bugs"`, and `"homepage"` once the GitHub URL exists
  (not added now — deliberately unknown at Phase 0).
- Add `"prepublishOnly": "npm run build"` so a stale `dist/` can never ship.
- Re-check `"files"` still matches what should ship (currently just `dist`).
- Confirm the package name `nestjs-swagger-drift` is still unclaimed on npm
  immediately before publishing (checked once already, at rename time).
