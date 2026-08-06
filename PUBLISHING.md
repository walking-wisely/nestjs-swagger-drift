# Publishing

Per PLAN.md §5, publishing is a Phase 5 exit criterion. **v0.1.0 published to
npm on 2026-08-06.**

`package.json` was prepped beforehand:

- [x] `"private": true` removed.
- [x] `"repository"`, `"bugs"`, `"homepage"` added, pointing at
      `github.com/walking-wisely/nestjs-swagger-drift`.
- [x] `"prepublishOnly": "npm run build"` added so a stale `dist/` can never
      ship.
- [x] `"files"` re-checked — still just `dist`; `npm pack --dry-run` confirms
      `LICENSE` and `README.md` are included automatically and no source/test
      files leak into the tarball.
- [x] `nestjs-swagger-drift` confirmed unclaimed on npm (checked 2026-08-06).

Done:

- [x] Version bumped `0.0.0` → `0.1.0`, published (`npm view` confirms
      `dist-tags.latest: 0.1.0`, maintainer `walking_wisely`).
- [x] Smoke-tested with `npx nestjs-swagger-drift@latest --help`.

Known gotcha found during the smoke test: a first cold `npx` run failed with
`Cannot find package 'typescript'` because `legacy-peer-deps=true` in
`~/.npmrc` skips npm's peer auto-install. Not a packaging bug — `typescript`
staying peer-only (not bundled) is the deliberate Phase 0 design so the tool
always analyzes with *your* project's TS version. Documented the workaround
in README's Installation section instead of changing the dependency shape.

Still to do:

- Tag the release in git (`git tag v0.1.0 && git push --tags`) and, if you
  want it discoverable on GitHub, cut a GitHub Release from that tag.
