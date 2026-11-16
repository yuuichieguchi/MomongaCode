import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBinaryHashCache, readProbeKeyComponents } from '@momonga/foundation';
import type { FileSystem, HostExec, ReadHandle } from '@momonga/foundation';

const CONTENT = 'the bytes the port serves';
const DIGEST = createHash('sha256').update(CONTENT).digest('hex');
const BINARY = '/fake/binary';

const recordingFiles = (): { files: Pick<FileSystem, 'stat' | 'openRead'>; calls: string[] } => {
  const calls: string[] = [];
  const bytes = Buffer.from(CONTENT);
  const files: Pick<FileSystem, 'stat' | 'openRead'> = {
    stat: async (file) => {
      calls.push(`stat ${file}`);
      return { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3 } as fs.Stats;
    },
    openRead: async (file) => {
      calls.push(`openRead ${file}`);
      let offset = 0;
      const handle: ReadHandle = {
        stat: () => Promise.reject(new Error('not used')),
        chmod: () => Promise.reject(new Error('not used')),
        read: async (page) => {
          const count = Math.min(page.length, bytes.length - offset);
          bytes.copy(page, 0, offset, offset + count);
          offset += count;
          return count;
        },
        readAt: () => Promise.reject(new Error('not used')),
        close: async () => {
          calls.push(`close ${file}`);
        },
      };
      return handle;
    },
  };
  return { files, calls };
};

const NO_EXEC: HostExec = () => Promise.reject(new Error('no command is run for a binary digest'));

describe('the binary digest reads the file through the file port', () => {
  it('stats and opens the binary through the port it is given, and never the disk beneath it', async () => {
    const { files, calls } = recordingFiles();
    const digest = await createBinaryHashCache(files).sha256Of(BINARY, new AbortController().signal);
    expect(digest).toBe(DIGEST);
    expect(calls).toEqual([`stat ${BINARY}`, `openRead ${BINARY}`, `close ${BINARY}`]);
  });

  it('reads a binary key component through the port the readings are given', async () => {
    const { files, calls } = recordingFiles();
    const readings = await readProbeKeyComponents({ identity: ['binarySha256'], binary: BINARY, platform: 'linux', exec: NO_EXEC, signal: new AbortController().signal, files });
    expect(readings).toEqual({ binarySha256: { kind: 'read', value: DIGEST } });
    expect(calls).toContain(`openRead ${BINARY}`);
  });
});
