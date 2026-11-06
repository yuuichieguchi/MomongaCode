import { describe, expect, it } from 'vitest';
import { createRipgrepLocator, ripgrepUnavailableMessage } from '../src/ripgrep-locator.ts';
import type { RipgrepLocatorPorts } from '../src/ripgrep-locator.ts';

const ABSOLUTE = '/opt/tools/rg';

type Calls = { bundled: number; onPath: number; regular: string[]; released: number };

const makePorts = (overrides: Partial<RipgrepLocatorPorts> = {}): { ports: RipgrepLocatorPorts; calls: Calls } => {
  const calls: Calls = { bundled: 0, onPath: 0, regular: [], released: 0 };
  const ports: RipgrepLocatorPorts = {
    setting: 'bundled',
    bundled: async () => {
      calls.bundled += 1;
      return { path: '/cache/ripgrep-15.2.0-abc/rg', version: '15.2.0', release: async () => void (calls.released += 1) };
    },
    onPath: async () => {
      calls.onPath += 1;
      return '/usr/local/bin/rg';
    },
    isRegularFile: async (file) => {
      calls.regular.push(file);
      return file === ABSOLUTE;
    },
    ...overrides,
  };
  return { ports, calls };
};

describe('ripgrepUnavailableMessage', () => {
  it('names the cause and the setting that selects another ripgrep', () => {
    expect(ripgrepUnavailableMessage('the cache is read-only')).toBe(
      'ripgrep is not available: the cache is read-only. Grep needs it. To use another ripgrep, set "tools.ripgrep" to "system" or to an absolute path in your user settings.',
    );
  });
});

describe('createRipgrepLocator', () => {
  it('uses the embedded copy when the setting is "bundled" and the executable embeds one, and never consults PATH', async () => {
    const { ports, calls } = makePorts();
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: true, path: '/cache/ripgrep-15.2.0-abc/rg', source: 'bundled', version: '15.2.0' });
    expect(calls.onPath).toBe(0);
  });

  it('reports the cause and does not fall back to PATH when the embedded copy cannot be extracted or verified', async () => {
    const { ports, calls } = makePorts({
      bundled: async () => {
        throw new Error('the embedded ripgrep does not match the checksum in its manifest');
      },
    });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toEqual({ ok: false, cause: 'the embedded ripgrep does not match the checksum in its manifest' });
    expect(calls.onPath).toBe(0);
  });

  it('uses PATH when the setting is "bundled" and this executable embeds no ripgrep', async () => {
    const { ports, calls } = makePorts({ bundled: undefined });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: true, path: '/usr/local/bin/rg', source: 'system' });
    expect(calls.onPath).toBe(1);
  });

  it('fails with a cause when nothing embedded and PATH has no rg', async () => {
    const { ports } = makePorts({ bundled: undefined, onPath: async () => undefined });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: false });
    expect(found.ok ? '' : found.cause).toMatch(/PATH/);
  });

  it('uses PATH for "system" even when the executable embeds a ripgrep', async () => {
    const { ports, calls } = makePorts({ setting: 'system' });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: true, path: '/usr/local/bin/rg', source: 'system' });
    expect(calls.bundled).toBe(0);
  });

  it('fails for "system" when PATH has no rg, and does not use the embedded copy', async () => {
    const { ports, calls } = makePorts({ setting: 'system', onPath: async () => undefined });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: false });
    expect(calls.bundled).toBe(0);
  });

  it('uses an absolute path that is a regular file, with neither the embedded copy nor PATH', async () => {
    const { ports, calls } = makePorts({ setting: ABSOLUTE });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: true, path: ABSOLUTE, source: 'path' });
    expect(calls.bundled).toBe(0);
    expect(calls.onPath).toBe(0);
  });

  it('fails with the path in the cause when the absolute path is not a regular file', async () => {
    const { ports } = makePorts({ setting: '/opt/tools/missing-rg' });
    const found = await createRipgrepLocator(ports).locate();
    expect(found).toMatchObject({ ok: false });
    expect(found.ok ? '' : found.cause).toContain('/opt/tools/missing-rg');
  });

  it('does not memoize a failure: the next locate asks again', async () => {
    let attempts = 0;
    const { ports } = makePorts({
      bundled: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('read-only cache');
        return { path: '/cache/rg', version: '15.2.0', release: async () => undefined };
      },
    });
    const locator = createRipgrepLocator(ports);
    expect(await locator.locate()).toMatchObject({ ok: false });
    expect(await locator.locate()).toMatchObject({ ok: true, path: '/cache/rg' });
  });

  it('asks the embedded copy on every locate, so that every spawn is preceded by its own check', async () => {
    const { ports, calls } = makePorts();
    const locator = createRipgrepLocator(ports);
    await locator.locate();
    await locator.locate();
    expect(calls.bundled).toBe(2);
  });

  it('passes the release of the embedded copy through', async () => {
    const { ports, calls } = makePorts();
    const found = await createRipgrepLocator(ports).locate();
    if (!found.ok) throw new Error('expected a ripgrep');
    await found.release();
    expect(calls.released).toBe(1);
  });
});
