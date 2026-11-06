import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeRemovesOpenFiles } from '@momonga/foundation';
import type { UnlinkOpenProbePorts } from '@momonga/foundation';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation failed`), { code });

const DIRECTORY = '/locks';

const fakePorts = (behaviour: { create?: NodeJS.ErrnoException; unlink?: NodeJS.ErrnoException }) => {
  const events: string[] = [];
  const open = new Set<number>();
  let nextDescriptor = 10;
  const ports: UnlinkOpenProbePorts = {
    createExclusive: (file) => {
      events.push(`create ${path.dirname(file)}`);
      if (behaviour.create !== undefined) throw behaviour.create;
      const descriptor = nextDescriptor++;
      open.add(descriptor);
      return descriptor;
    },
    unlink: (file) => {
      events.push(`unlink while ${open.size > 0 ? 'open' : 'closed'} ${path.dirname(file)}`);
      if (behaviour.unlink !== undefined && open.size > 0) throw behaviour.unlink;
    },
    close: (descriptor) => {
      events.push('close');
      open.delete(descriptor);
    },
  };
  return { ports, events, open };
};

describe('removesOpenFiles by test (B18)', () => {
  it('is supported when unlinking the open probe file succeeds', () => {
    const { ports, events, open } = fakePorts({});
    expect(probeRemovesOpenFiles(DIRECTORY, ports).kind).toBe('supported');
    expect(events).toEqual([`create ${DIRECTORY}`, `unlink while open ${DIRECTORY}`, 'close']);
    expect(open.size).toBe(0);
  });

  it.each(['EBUSY', 'EPERM'])('is unsupported when unlinking the open probe file fails with %s, and the probe file is still removed', (code) => {
    const { ports, events, open } = fakePorts({ unlink: errno(code) });
    const result = probeRemovesOpenFiles(DIRECTORY, ports);
    expect(result.kind).toBe('unsupported');
    expect(result.evidence).toContain(code);
    expect(events).toEqual([`create ${DIRECTORY}`, `unlink while open ${DIRECTORY}`, 'close', `unlink while closed ${DIRECTORY}`]);
    expect(open.size).toBe(0);
  });

  it('is unmeasured when the probe file cannot be created', () => {
    const { ports, events } = fakePorts({ create: errno('EACCES') });
    const result = probeRemovesOpenFiles(DIRECTORY, ports);
    expect(result.kind).toBe('unmeasured');
    expect(result.evidence).toContain('EACCES');
    expect(events).toEqual([`create ${DIRECTORY}`]);
  });

  it('is unmeasured when unlink fails for a reason that does not answer the question', () => {
    const { ports, open } = fakePorts({ unlink: errno('EIO') });
    const result = probeRemovesOpenFiles(DIRECTORY, ports);
    expect(result.kind).toBe('unmeasured');
    expect(result.evidence).toContain('EIO');
    expect(open.size).toBe(0);
  });
});
