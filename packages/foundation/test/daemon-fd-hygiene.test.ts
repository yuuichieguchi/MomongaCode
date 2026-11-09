import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, spawnTracked, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fd-hygiene-daemon.ts');

type Probe = { variants: Record<string, string>; inherit: string };

const runDaemon = async (context: CleanupContext): Promise<Probe> => {
  const marker = path.join(withTempDir(context), 'daemon.marker');
  fs.writeFileSync(marker, '', { mode: 0o600 });
  const markerFd = fs.openSync(marker, 'r');
  let child;
  try {
    child = spawnTracked(context, process.execPath, [DAEMON], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', markerFd] });
  } finally {
    fs.closeSync(markerFd);
  }
  let stdout = '';
  let stderr = '';
  (child.stdout as Readable).on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.once('close', (exitCode) => resolve(exitCode)));
  expect(code, stderr).toBe(0);
  const inherit = /<<inherit\n([\s\S]*?)>>inherit\n/.exec(stdout);
  expect(inherit, stdout).not.toBeNull();
  const lastLine = stdout.trimEnd().split('\n').at(-1) as string;
  return { variants: JSON.parse(lastLine) as Record<string, string>, inherit: (inherit as RegExpExecArray)[1] as string };
};

describe('daemon fd hygiene', () => {
  it('fd hygiene: grandchildren do not inherit fds 3 and 4', async (context) => {
    const probe = await runDaemon(context);
    expect(probe.variants['execFile']).toBe('');
    expect(probe.variants['spawn']).toBe('');
    expect(probe.variants['spawnDetached']).toBe('');
    expect(probe.inherit).toBe('');
  });

  it('fd hygiene: explicit mapping passes the fds', async (context) => {
    const probe = await runDaemon(context);
    expect(probe.variants['explicit']).toBe('fd3\nfd4\n');
  });
});
