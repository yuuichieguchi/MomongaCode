import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { E2E_READY_DEADLINE_MS, until } from '../e2e/support/wait.ts';
import { startFakeReleaseServer, checksumListing } from '../packages/cli/test/fake-release-server.ts';
import type { FakeReleaseServer } from '../packages/cli/test/fake-release-server.ts';
import { repoRoot } from './bundle.ts';
import { bundle } from './bundle.ts';
import { buildSea } from './sea.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';
import { RUNS_MACOS_ARM64_ARTIFACTS } from './support/host.ts';

const FIXTURE_REPO = 'acme/momonga';
const ASSET = 'momonga-darwin-arm64';
const MAIN_ENTRY = `${repoRoot}packages/cli/src/main.ts`;

type Installation = { bin: string; dir: string; home: string };
type Outcome = { code: number | null; stdout: string; stderr: string };

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('self-update on built single executables', () => {
  let root = '';
  let v1 = '';
  let v2 = '';
  let server: FakeReleaseServer;
  let instances = 0;
  const installationRoots: string[] = [];

  const bytes = (file: string): Buffer => fs.readFileSync(file);

  const install = (): Installation => {
    instances += 1;
    const base = path.join(root, `i${instances}`);
    installationRoots.push(base);
    const dir = path.join(base, 'bin');
    const home = path.join(root, 'h');
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(home);
    const bin = path.join(dir, 'momonga');
    fs.copyFileSync(v1, bin);
    fs.chmodSync(bin, 0o755);
    return { bin: fs.realpathSync(bin), dir: fs.realpathSync(dir), home: fs.realpathSync(home) };
  };

  const run = (file: string, args: readonly string[], home: string, env: Record<string, string> = {}): Promise<Outcome> =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: home, MOMONGA_FIXTURE_RELEASE_URL: server.endpoints.apiBaseUrl, ...env } },
        (error, stdout, stderr) => {
          if (error === null) resolve({ code: 0, stdout, stderr });
          else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
          else reject(error);
        },
      );
    });

  const publishV2 = (options: { checksums?: string } = {}): void => {
    server.publish('v2.0.0', { [ASSET]: bytes(v2) }, options.checksums === undefined ? {} : { checksums: options.checksums });
  };

  const versionOf = async (installation: Installation): Promise<string> => (await run(installation.bin, ['--version'], installation.home)).stdout;

  beforeAll(async () => {
    root = createTempRoot();
    v1 = path.join(root, 'v1');
    v2 = path.join(root, 'v2');
    await buildSea({ entry: `${repoRoot}test/fixtures/sea/update-v1.ts`, output: v1, workDir: path.join(root, 'work1') });
    server = await startFakeReleaseServer(FIXTURE_REPO);
  });

  beforeAll(async () => {
    await buildSea({ entry: `${repoRoot}test/fixtures/sea/update-v2.ts`, output: v2, workDir: path.join(root, 'work2') });
  });

  afterEach(() => {
    for (const base of installationRoots.splice(0)) fs.rmSync(base, { recursive: true, force: true });
  });

  afterAll(async () => {
    await server.stop();
    removeTempRoot(root);
  });

  it('replaces the running executable with the verified release and the new binary runs', async () => {
    const installation = install();
    publishV2();

    const outcome = await run(installation.bin, ['update'], installation.home);

    expect(outcome).toEqual({ code: 0, stdout: `updated momonga 1.0.0 -> 2.0.0 (${installation.bin})\n`, stderr: '' });
    expect(bytes(installation.bin).equals(bytes(v2))).toBe(true);
    expect(fs.readdirSync(installation.dir)).toEqual(['momonga']);
    expect(fs.statSync(installation.bin).mode & 0o777).toBe(0o755);
    expect(await versionOf(installation)).toBe('2.0.0\n');
    expect(spawnSync('/usr/bin/codesign', ['--verify', '--strict', installation.bin]).status).toBe(0);
  });

  it('reports up to date once the release is installed', async () => {
    const installation = install();
    publishV2();
    await run(installation.bin, ['update'], installation.home);

    const outcome = await run(installation.bin, ['update'], installation.home);

    expect(outcome).toEqual({ code: 0, stdout: 'momonga 2.0.0 is up to date\n', stderr: '' });
  });

  it('keeps the installed binary when the asset was tampered with', async () => {
    const installation = install();
    publishV2({ checksums: checksumListing({ [ASSET]: Buffer.from('what was published') }) });

    const outcome = await run(installation.bin, ['update'], installation.home);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('does not match SHA256SUMS');
    expect(bytes(installation.bin).equals(bytes(v1))).toBe(true);
    expect(fs.readdirSync(installation.dir)).toEqual(['momonga']);
    expect(await versionOf(installation)).toBe('1.0.0\n');
  });

  it('keeps the installed binary when the download is interrupted', async () => {
    const installation = install();
    publishV2();
    const asset = server.files.get(`v2.0.0/${ASSET}`);
    if (asset === undefined) throw new Error('asset was not published');
    asset.interruptAfterBytes = 1_000_000;

    const outcome = await run(installation.bin, ['update'], installation.home);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('downloading the release executable was interrupted');
    expect(bytes(installation.bin).equals(bytes(v1))).toBe(true);
    expect(fs.readdirSync(installation.dir)).toEqual(['momonga']);
  });

  it('keeps the installed binary when the real codesign rejects the release signature', async () => {
    const installation = install();
    publishV2();

    const outcome = await run(installation.bin, ['update'], installation.home, { MOMONGA_FIXTURE_REAL_CODESIGN: '1' });

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('not a valid Developer ID signature of Apple Team ID ABCDE12345');
    expect(outcome.stderr).toContain('code failed to satisfy specified code requirement');
    expect(bytes(installation.bin).equals(bytes(v1))).toBe(true);
    expect(fs.readdirSync(installation.dir)).toEqual(['momonga']);
  });

  it('refuses a downgrade', async () => {
    const installation = install();
    server.publish('v0.5.0', { [ASSET]: bytes(v2) });

    const outcome = await run(installation.bin, ['update'], installation.home);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('refusing to downgrade');
    expect(bytes(installation.bin).equals(bytes(v1))).toBe(true);
  });

  it('installs a newer release in the background after an ordinary command and announces it once', async () => {
    const installation = install();
    publishV2();
    const stateFile = path.join(installation.home, '.momonga', 'state', 'update.json');

    const first = await run(installation.bin, ['daemon', 'status'], installation.home);
    expect(first.stderr).toBe('');

    await until(() => fs.existsSync(stateFile) && (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { outcome: { kind: string } }).outcome.kind === 'installed', {
      deadlineMs: E2E_READY_DEADLINE_MS,
      description: 'the background check to record the installed update',
    });
    expect(bytes(installation.bin).equals(bytes(v2))).toBe(true);

    const second = await run(installation.bin, ['daemon', 'status'], installation.home);
    expect(second.stderr).toBe('momonga: momonga was updated to 2.0.0 in the background\n');
    const third = await run(installation.bin, ['daemon', 'status'], installation.home);
    expect(third.stderr).toBe('');
  });

  it('restarts a running daemon on the new version', async () => {
    const installation = install();
    fs.mkdirSync(path.join(installation.home, '.momonga'));
    fs.writeFileSync(
      path.join(installation.home, '.momonga', 'settings.json'),
      JSON.stringify({
        autoUpdates: false,
        sandbox: 'none',
        models: {
          aliases: { default: ['up'] },
          targets: { up: { adapter: 'chat-completions', provider: 'fake', model: 'm', baseUrl: 'http://127.0.0.1:9', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } } },
        },
      }),
    );
    publishV2();
    try {
      const started = await run(installation.bin, ['daemon', 'start'], installation.home);
      expect(started.stdout).toMatch(/^momonga daemon running: pid \d+, version 1\.0\.0\n$/);

      const outcome = await run(installation.bin, ['update'], installation.home);

      expect(outcome.stdout).toBe(`updated momonga 1.0.0 -> 2.0.0 (${installation.bin})\nrestarted the daemon on the new version\n`);
      const status = await run(installation.bin, ['daemon', 'status'], installation.home);
      expect(status.stdout).toContain('version 2.0.0');
    } finally {
      await run(installation.bin, ['daemon', 'stop'], installation.home);
    }
  });
});

describe.skipIf(!RUNS_MACOS_ARM64_ARTIFACTS)('build-time update source', () => {
  let root = '';

  beforeAll(() => {
    root = createTempRoot();
  });

  afterEach(() => {
    for (const binary of ['no-source', 'no-team']) fs.rmSync(path.join(root, binary), { force: true });
  });

  afterAll(() => {
    removeTempRoot(root);
  });

  it('is absent from a bundle built without inputs and embedded in one built with them', async () => {
    const plain = path.join(root, 'plain.mjs');
    const configured = path.join(root, 'configured.mjs');
    await bundle({ entry: MAIN_ENTRY, outfile: plain });
    await bundle({ entry: MAIN_ENTRY, outfile: configured, releaseRepo: 'acme/momonga', teamId: 'ABCDE12345' });

    expect(fs.readFileSync(plain, 'utf8')).not.toContain('acme/momonga');
    expect(fs.readFileSync(configured, 'utf8')).toContain('"acme/momonga"');
    expect(fs.readFileSync(configured, 'utf8')).toContain('"ABCDE12345"');
  });

  it('rejects malformed inputs at build time', async () => {
    const outfile = path.join(root, 'bad.mjs');
    await expect(bundle({ entry: MAIN_ENTRY, outfile, releaseRepo: 'no-slash' })).rejects.toThrow('--repo must be <owner>/<repo>');
    await expect(bundle({ entry: MAIN_ENTRY, outfile, teamId: 'lower' })).rejects.toThrow('--team-id must be a 10-character Apple Team ID');
  });

  it('makes a bundle run by node refuse to replace node', async () => {
    const configured = path.join(root, 'configured-run.mjs');
    await bundle({ entry: MAIN_ENTRY, outfile: configured, releaseRepo: 'acme/momonga', teamId: 'ABCDE12345' });

    const result = spawnSync(process.execPath, [configured, 'update'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('self-update only replaces a momonga single executable; this process is running from source under node');
  });

  it('makes a real executable built without inputs report that it has no update source', async () => {
    const binary = path.join(root, 'no-source');
    await buildSea({ entry: MAIN_ENTRY, output: binary, workDir: path.join(root, 'work-no-source') });

    const result = spawnSync(binary, ['update'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('momonga: this build has no update source: it was built without MOMONGA_REPO');
    expect(result.stderr).toContain('remedy: install a release build');
  });

  it('makes a real executable built with a repository but no team report the missing team on macOS', async () => {
    const binary = path.join(root, 'no-team');
    await buildSea({ entry: MAIN_ENTRY, output: binary, workDir: path.join(root, 'work-no-team'), releaseRepo: 'acme/momonga' });

    const result = spawnSync(binary, ['update'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('built without MOMONGA_TEAM_ID');
  });
});
