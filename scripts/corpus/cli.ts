import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blockingReasons,
  buildVerdictFile,
  computeDelta,
  groupClasses,
  rebaseline,
  rollupSites,
  type RunFinding,
  type VerdictFile,
} from './lib.ts';

interface RepoConfig {
  remote: string;
  sha: string;
  tsconfig: string;
  flags: string[];
  prepare: string[];
  tiers: string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'corpus/manifest.json'), 'utf8')) as {
  repos: Record<string, RepoConfig>;
};
const cacheRoot =
  process.env['CORPUS_CACHE_DIR'] ?? join(homedir(), '.cache', 'nestjs-swagger-drift-corpus');
const toolBin = join(root, 'dist/cli/index.js');
const toolVersion = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
).version;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'inherit' });
}

function prepare(id: string, repo: RepoConfig): string {
  const dir = join(cacheRoot, id);
  const marker = join(dir, '.corpus-prepared');
  const stamp = JSON.stringify({ sha: repo.sha, prepare: repo.prepare });
  if (existsSync(marker) && readFileSync(marker, 'utf8') === stamp) return dir;

  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '--quiet');
    git(dir, 'remote', 'add', 'origin', repo.remote);
  }
  git(dir, 'fetch', '--quiet', '--depth', '1', 'origin', repo.sha);
  git(dir, 'checkout', '--quiet', '--force', repo.sha);
  git(dir, 'clean', '--quiet', '-fdx', '-e', 'node_modules');
  for (const command of repo.prepare) {
    const result = spawnSync(command, { cwd: dir, shell: true, stdio: 'inherit' });
    if (result.status !== 0) fail(`prepare step failed (${result.status}): ${command}`);
  }
  writeFileSync(marker, stamp);
  return dir;
}

function detect(dir: string, repo: RepoConfig): RunFinding[] {
  if (!existsSync(toolBin)) fail(`${toolBin} missing — run npm run build first`);
  const result = spawnSync(
    process.execPath,
    [
      toolBin,
      '--project',
      join(dir, repo.tsconfig),
      '--base-dir',
      dir,
      '--reporter',
      'json',
      ...repo.flags,
    ],
    { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.status !== 3) {
    fail(`analysis did not complete (exit ${result.status}):\n${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { findings: RunFinding[] }).findings;
}

function verdictsPath(id: string): string {
  return join(root, 'corpus', id, 'verdicts.json');
}

function parseArgs(argv: string[]): { command: string; id: string; out: string } {
  const [command, id, ...rest] = argv;
  if (!command || !id)
    fail('usage: corpus <prepare|run|bootstrap|report|rebaseline> <repo-id> [--out <dir>]');
  const outIdx = rest.indexOf('--out');
  const out =
    outIdx === -1
      ? join(root, 'corpus-out')
      : resolve(rest[outIdx + 1] ?? fail('--out needs a value'));
  return { command, id, out };
}

const { command, id, out } = parseArgs(process.argv.slice(2));
const repo =
  manifest.repos[id] ??
  fail(`unknown repo "${id}"; known: ${Object.keys(manifest.repos).join(', ')}`);

if (command === 'prepare') {
  console.log(`prepared ${prepare(id, repo)}`);
} else if (command === 'bootstrap') {
  if (existsSync(verdictsPath(id)))
    fail(`${verdictsPath(id)} already exists; refusing to overwrite`);
  const findings = detect(prepare(id, repo), repo);
  const file = buildVerdictFile(
    repo.sha,
    toolVersion,
    new Date().toISOString().slice(0, 10),
    findings,
  );
  mkdirSync(dirname(verdictsPath(id)), { recursive: true });
  writeFileSync(verdictsPath(id), JSON.stringify(file, undefined, 2) + '\n');
  console.log(`${id}: recorded ${findings.length} finding(s) as UNTRIAGED`);
} else if (command === 'report') {
  const findings = detect(prepare(id, repo), repo);
  const classes = groupClasses(findings);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}.classes.json`), JSON.stringify(classes, undefined, 2) + '\n');
  const sites = rollupSites(findings);
  writeFileSync(join(out, `${id}.sites.json`), JSON.stringify(sites, undefined, 2) + '\n');
  console.log(
    `${id}: ${findings.length} finding(s), ${sites.length} distinct (status, site) pair(s), ${classes.length} class(es)\n`,
  );
  console.log('top sites (a finding counts once per site it touches):');
  for (const site of sites.slice(0, 15)) {
    console.log(
      `${String(site.findings).padStart(5)}  ${String(site.callers).padStart(3)} callers  ${site.site}`,
    );
  }
  console.log('');
  for (const c of classes) {
    console.log(
      `${String(c.count).padStart(5)}  ${String(c.files).padStart(4)} files ${String(c.callers).padStart(3)} callers  ${c.id}`,
    );
    for (const sample of c.samples.slice(0, 2))
      console.log(`         e.g. ${sample.at}  ${sample.key}`);
  }
  console.log(`\nfull sample list: ${join(out, `${id}.classes.json`)}`);
} else if (command === 'rebaseline') {
  const baseline = JSON.parse(readFileSync(verdictsPath(id), 'utf8')) as VerdictFile;
  if (baseline.pin !== repo.sha)
    fail(`verdicts pin ${baseline.pin} does not match manifest ${repo.sha}`);
  const findings = detect(prepare(id, repo), repo);
  const result = rebaseline(
    baseline,
    findings,
    toolVersion,
    new Date().toISOString().slice(0, 10),
    process.argv.includes('--accept-lost'),
  );
  if (!result.file) fail(`refusing to rebaseline ${id}:\n  ${result.refusals.join('\n  ')}`);
  writeFileSync(verdictsPath(id), JSON.stringify(result.file, undefined, 2) + '\n');
  console.log(`${id}: baseline now holds ${findings.length} finding(s)`);
} else if (command === 'run') {
  if (!existsSync(verdictsPath(id)))
    fail(`no baseline for ${id}; run "corpus bootstrap ${id}" first`);
  const baseline = JSON.parse(readFileSync(verdictsPath(id), 'utf8')) as VerdictFile;
  if (baseline.pin !== repo.sha)
    fail(`verdicts pin ${baseline.pin} does not match manifest ${repo.sha}; verdicts are stale`);

  const findings = detect(prepare(id, repo), repo);
  const delta = computeDelta(baseline.entries, findings);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${id}.delta.json`), JSON.stringify(delta, undefined, 2) + '\n');

  console.log(
    `${id}: ${findings.length} finding(s) — unchanged ${delta.unchanged.length}, new ${delta.added.length}, ` +
      `disappeared ${delta.disappeared.length}, changed ${delta.changed.length}`,
  );
  const reasons = blockingReasons(delta);
  for (const reason of reasons) console.error(`BLOCKING: ${reason}`);
  process.exit(reasons.length > 0 ? 1 : 0);
} else {
  fail(`unknown command "${command}"`);
}
