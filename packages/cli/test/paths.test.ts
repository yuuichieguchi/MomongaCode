import { describe, expect, it, vi } from 'vitest';

const ensured = vi.hoisted(() => ({ calls: [] as Array<{ root: string; platform: NodeJS.Platform | undefined }> }));

vi.mock('@momonga/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@momonga/foundation')>()),
  ensureMomongaDirs: async (paths: { root: string }, ports: { platform?: NodeJS.Platform }) => {
    ensured.calls.push({ root: paths.root, platform: ports.platform });
  },
}));

const { pathsOf } = await import('../src/paths.ts');

describe('pathsOf', () => {
  it('lays the paths out for the platform of the ports, not the platform of the process', async () => {
    const home = '/tmp';

    const windows = await pathsOf({ home, platform: 'win32', interrupt: new AbortController().signal });
    const linux = await pathsOf({ home, platform: 'linux', interrupt: new AbortController().signal });

    expect(windows.current).not.toBe(linux.current);
  });

  it('hands the paths out only after ensuring the private tree for the platform of the ports', async () => {
    ensured.calls.length = 0;

    const paths = await pathsOf({ home: '/tmp', platform: 'linux', interrupt: new AbortController().signal });

    expect(ensured.calls).toEqual([{ root: paths.root, platform: 'linux' }]);
  });
});
