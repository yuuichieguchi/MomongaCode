import { describe, expect, it } from 'vitest';
import { inspectorKindOf } from '../../src/platform/process-inspector.ts';
import type { InspectorKindProbes } from '../../src/platform/process-inspector.ts';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const host = (offered: { proc?: boolean; executables?: readonly string[]; env?: Record<string, string>; procFails?: string }): InspectorKindProbes => ({
  readText: async (file) => {
    if (offered.procFails !== undefined) throw errno(offered.procFails);
    if (offered.proc === true && file === '/proc/self/stat') return '1 (node) R 0';
    throw errno('ENOENT');
  },
  list: async (directory) => {
    if (offered.proc === true && directory === '/proc/self/fd') return ['0', '1', '2'];
    throw errno('ENOENT');
  },
  isExecutable: async (file) => (offered.executables ?? []).includes(file),
  env: offered.env ?? {},
});

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

describe('the process inspector is chosen by what the host offers, never by its name (B1)', () => {
  it('chooses the procfs inspector where /proc/self/stat and /proc/self/fd can be read', async () => {
    expect(await inspectorKindOf(host({ proc: true, executables: ['/usr/sbin/lsof', '/bin/ps'] }))).toMatchObject({ kind: 'supported', value: 'procfs' });
  });

  it('chooses the lsof inspector where there is no /proc but lsof and ps are executable', async () => {
    expect(await inspectorKindOf(host({ executables: ['/usr/sbin/lsof', '/bin/ps'] }))).toMatchObject({ kind: 'supported', value: 'lsof' });
  });

  it('chooses the PowerShell inspector where neither is offered and Windows PowerShell is executable', async () => {
    expect(await inspectorKindOf(host({ executables: [POWERSHELL], env: { SystemRoot: 'C:\\Windows' } }))).toMatchObject({ kind: 'supported', value: 'powershell' });
  });

  it('is unsupported where none is offered, naming everything it looked for', async () => {
    const result = await inspectorKindOf(host({ executables: ['/usr/sbin/lsof'] }));
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain('/proc/self/stat');
    expect(result.evidence).toContain('/usr/sbin/lsof');
    expect(result.evidence).toContain('/bin/ps');
    expect(result.evidence).toContain('PowerShell');
  });

  it('lets a failure other than absence propagate, so no inspector is guessed', async () => {
    await expect(inspectorKindOf(host({ procFails: 'EIO' }))).rejects.toThrow('EIO');
  });
});
