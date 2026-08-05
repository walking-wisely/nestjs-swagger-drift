# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) rather than a
public issue. We'll acknowledge within a few days.

## Supply chain

This package ships with **zero runtime `dependencies`** — only
`devDependencies` and a `peerDependency` on `typescript`. Installing it in a
consumer project pulls in no transitive packages. Automated checks on this
repo:

- [Dependabot](.github/dependabot.yml) — version updates for
  devDependencies and GitHub Actions
- [Socket Security](https://socket.dev) — behavioral scanning of dependency
  updates (install scripts, obfuscation, typosquats) on every PR
- `npm audit` / `npm audit signatures` — run in CI on every push and PR
- [CodeQL](.github/workflows/codeql.yml) — static analysis of this repo's
  own source
