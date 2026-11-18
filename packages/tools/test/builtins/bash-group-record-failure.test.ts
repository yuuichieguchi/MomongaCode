import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UNMEASURED_CAPABILITY, createMarker, createProcessInspector, hostInspectorPorts, recordMarkerGroup, systemRandom } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import { TEST_BUILTIN_TOOL_OFFER, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_TOOL_LIMITS, testPaths, testLocks, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { createMarkerSettle, nodeShellHost } from '@momonga/tools';
import type { ToolContext } from '@momonga/tools';
import { bashToolFor } from '../../src/builtins/bash.ts';
import { makeClock, makeLayout } from '../helpers.ts';
import { trackGroup, trackPid, waitFor } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const NOT_AN_ATTEMPT_RECORD = 'not an attempt record\n';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('Bash when recording the process group into the marker fails', () => {
  it('still waits for the real exit and settles the marker with the group it holds in memory, stopping what outlived the command, and reports the failed record once', async () => {
    const layout = makeLayout();
    const markerDir = path.join(layout.root, 'markers');
    fs.mkdirSync(markerDir, { mode: 0o700 });
    const marker = path.join(markerDir, 'call-1');
    const handle = await createMarker(marker, { capability: UNMEASURED_CAPABILITY });
    fs.writeFileSync(marker, NOT_AN_ATTEMPT_RECORD);
    const warnings: string[] = [];
    const inspector = createProcessInspector(process.platform, { ...hostInspectorPorts(testLocks().capability), capability: UNMEASURED_CAPABILITY } as never);
    const settle = createMarkerSettle({ marker, mode: handle.mode, inspector, killGraceMs: 300, onWarning: (message) => void warnings.push(message) });
    const recordFailures: unknown[] = [];
    const attached: number[] = [];
    const ctx = {
      runId: 'run-1',
      step: 1,
      callId: 'call-1',
      idemKey: 'call-1',
      cwd: layout.project,
      workingDirectory: layout.project,
      home: layout.home,
      roots: [layout.project],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      signal: new AbortController().signal,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      clock: makeClock(),
      shellHost: nodeShellHost(),
      random: systemRandom,
      session: { cwd: layout.project },
      paths: testPaths(),
      sandbox: createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 300 }),
      sandboxPolicy: {},
      processMarker: marker,
      spawnMarker: async () => ({ file: marker, fd: handle.fd, mode: handle.mode, settle }),
      attachProcess: async ({ pgid }: { pgid: number; startedAt: number }) => {
        attached.push(pgid);
        trackGroup(pgid);
        try {
          await recordMarkerGroup(marker, pgid);
        } catch (error) {
          recordFailures.push(error);
          throw error;
        }
      },
      update: () => undefined,
      checkpoint: () => undefined,
      reportProgress: () => undefined,
      limits: TEST_TOOL_LIMITS,
      expired: new AbortController().signal,
      stopForTimeout: () => undefined,
    } as unknown as ToolContext;

    const ready = path.join(layout.project, 'escaped');
    const command = `perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", $ARGV[0]); close $f; sleep 30' ${ready} >/dev/null 2>&1 & while [ ! -e ${ready} ]; do sleep 0.05; done; echo "pid:$!"; echo finished`;
    const result = await bashToolFor(TEST_BUILTIN_TOOL_OFFER).execute({ command }, ctx, undefined);

    const { output: printed, notes = [] } = result as { output: string; notes?: string[] };
    const output = [printed, ...notes].join('\n');
    const outlived = Number(/pid:(\d+)/.exec(output)?.[1]);
    if (outlived > 1) trackPid(outlived);
    expect(recordFailures).toHaveLength(1);
    const reason = (recordFailures[0] as Error).message;
    expect(attached).toHaveLength(1);
    expect(result).toMatchObject({ status: 'completed' });
    expect(output).toContain('finished');
    expect(output).toContain('Terminated 1 process(es) that outlived the command.');
    expect(await waitFor(() => !isAlive(outlived), 10_000)).toBe(true);
    const reports = [output, ...warnings].filter((text) => text.includes(reason));
    expect(reports).toHaveLength(1);
    expect(occurrences(reports[0] ?? '', reason)).toBe(1);
    expect(reports[0]).toContain(marker);
  });
});
