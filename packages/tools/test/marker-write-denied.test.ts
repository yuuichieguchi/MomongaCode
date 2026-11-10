import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, UNMEASURED_CAPABILITY, createLockCapability, createMarker, momongaLayout, readAttemptRecord, readMarkerGroup, recordMarkerGroup } from '@momonga/foundation';
import type { LockCapabilityProbe } from '@momonga/foundation';
import { buildSandboxPolicy } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { trackGroup } from './builtins/fixtures.ts';
import { HAS_REAL_SANDBOX, HOST_SANDBOX_KIND, createHostSandbox, makeLayout } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const RECORDED_GROUP = 4321;
const FORGED_GROUP_LINE = 'g0000000001\n';

const capabilities: Array<[string, (proofDir: string) => LockCapabilityProbe]> = [
  ['listed', () => UNMEASURED_CAPABILITY],
  ['locked', (proofDir) => createLockCapability({ proofDir })],
];

describe.runIf(HAS_REAL_SANDBOX).each(capabilities)(`a spawn's marker file under the ${HOST_SANDBOX_KIND} sandbox of this host (%s marker)`, (_mode, capabilityFor) => {
  const setup = async () => {
    const layout = makeLayout();
    const paths = momongaLayout(layout.home);
    fs.mkdirSync(paths.markers.tools, { recursive: true });
    const proofDir = path.join(layout.root, 'proof');
    fs.mkdirSync(proofDir, { mode: 0o700 });
    const marker = path.join(paths.markers.tools, 'call-1');
    const handle = await createMarker(marker, { capability: capabilityFor(proofDir) });
    await recordMarkerGroup(marker, RECORDED_GROUP);
    const sandboxTmpRoot = path.join(layout.root, 'sandbox-tmp');
    fs.mkdirSync(sandboxTmpRoot);
    const tmpDir = path.join(paths.tmp.sessions, 'own-session');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const policy = buildSandboxPolicy({ roots: [layout.home], home: layout.home, tmpDir, sessionsTmpRoot: paths.tmp.sessions, fileRules: EMPTY_FILE_RULES, protectedSet: EMPTY_PROTECTED_SET, network: 'deny' });
    const sandbox = createHostSandbox({ tmpRoot: sandboxTmpRoot, killGraceMs: 300 });
    const runChild = async (script: string) => {
      const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: layout.project, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, tmpDir, markerFile: marker }, policy, new AbortController().signal, { markerFd: handle.fd });
      trackGroup(proc.pgid);
      const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      return { code: exit.code, stdout, stderr };
    };
    return { marker, handle, runChild };
  };

  it('refuses the child opening its marker file for writing by path, even when a session root contains the whole home', async () => {
    const { marker, handle, runChild } = await setup();
    try {
      const before = fs.readFileSync(marker, 'utf8');
      const attempts = await runChild(
        [
          `if printf 'r00000\\n${FORGED_GROUP_LINE}' > '${marker}' 2>/dev/null; then echo overwrite-written; else echo overwrite-refused; fi`,
          `if printf '${FORGED_GROUP_LINE}' >> '${marker}' 2>/dev/null; then echo append-written; else echo append-refused; fi`,
          `if printf '${FORGED_GROUP_LINE}' 1<> '${marker}' 2>/dev/null; then echo readwrite-written; else echo readwrite-refused; fi`,
        ].join('\n'),
      );
      expect(attempts.stdout).toBe('overwrite-refused\nappend-refused\nreadwrite-refused\n');
      expect(fs.readFileSync(marker, 'utf8')).toBe(before);
      expect(await readMarkerGroup(marker)).toBe(RECORDED_GROUP);
    } finally {
      handle.close();
    }
  });

  it('refuses the child writing through the marker descriptor it inherits', async () => {
    const { marker, handle, runChild } = await setup();
    try {
      const before = fs.readFileSync(marker, 'utf8');
      const throughDescriptor = await runChild(`printf '${FORGED_GROUP_LINE}' >&3`);
      expect(fs.readFileSync(marker, 'utf8')).toBe(before);
      expect(await readMarkerGroup(marker)).toBe(RECORDED_GROUP);
      expect(throughDescriptor.code).not.toBe(0);
    } finally {
      handle.close();
    }
  });

  it('refuses the child forging the attempt record through the inherited descriptor, so the ignored byte and every spent byte stay as the host wrote them', async () => {
    const { marker, handle, runChild } = await setup();
    try {
      const before = fs.readFileSync(marker, 'utf8');
      const recordBefore = await readAttemptRecord(marker);
      const forge = await runChild(`/usr/bin/perl -e 'open(my $f, "+<&=3") or exit 3; sysseek($f, 5, 0) or exit 4; (syswrite($f, "1") // 0) == 1 or exit 5; exit 0'`);
      expect(fs.readFileSync(marker, 'utf8')).toBe(before);
      expect(await readAttemptRecord(marker)).toEqual(recordBefore);
      expect((await readAttemptRecord(marker)).ignored).toBe(false);
      expect(forge.code).not.toBe(0);
    } finally {
      handle.close();
    }
  });
});
