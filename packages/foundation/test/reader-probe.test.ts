import { describe, expect, it } from 'vitest';
import { PID_NAMESPACE_LINK, SINGLE_PID_SPACE, pidNamespaceOf, probeReader } from '../src/process-alive.ts';

const failing = (code: string) => ({ readlink: (): Promise<string> => Promise.reject(Object.assign(new Error(`${code}: ${PID_NAMESPACE_LINK}`), { code })) });

describe('the pid namespace a process probe is valid in', () => {
  it('is the target of the pid namespace link where the host has one', async () => {
    const asked: string[] = [];
    expect(await pidNamespaceOf({ readlink: async (link) => (asked.push(link), 'pid:[4026531836]') })).toBe('pid:[4026531836]');
    expect(asked).toEqual([PID_NAMESPACE_LINK]);
  });

  it('is the single pid space of a host that has no such link', async () => {
    expect(await pidNamespaceOf(failing('ENOENT'))).toBe(SINGLE_PID_SPACE);
  });

  it('rejects with the code when the link exists and cannot be read', async () => {
    await expect(pidNamespaceOf(failing('EACCES'))).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('the probe of a named reader', () => {
  it('answers alive or gone only in the namespace it runs in', () => {
    expect(probeReader({ pid: 7, namespace: 'pid:[1]' }, 'pid:[1]', () => true)).toEqual({ kind: 'alive' });
    expect(probeReader({ pid: 7, namespace: 'pid:[1]' }, 'pid:[1]', () => false)).toEqual({ kind: 'gone' });
  });

  it('answers not in this namespace without probing a reader of another one', () => {
    const probed: number[] = [];
    expect(probeReader({ pid: 7, namespace: 'pid:[2]' }, 'pid:[1]', (pid) => (probed.push(pid), false))).toEqual({ kind: 'elsewhere', namespace: 'pid:[2]' });
    expect(probed).toEqual([]);
  });
});
