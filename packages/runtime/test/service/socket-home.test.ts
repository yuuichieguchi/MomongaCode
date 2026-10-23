import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, createFakePorts, createNotifier, launchService, makeLayout, onCleanup, openStore, serviceOptions } from './helpers.ts';
import type { Layout } from './helpers.ts';

const attempt = async (layout: Layout, socketPath: string, home: string) => {
  const clock = createFakeClock(START_MS);
  const notifier = createNotifier();
  const store = openStore(layout.dbPath, clock, { notifier });
  const options = serviceOptions({ store, clock, home, socketPath, ports: createFakePorts(), notifier, errors: [] });
  const service = await launchService(options);
  onCleanup(() => service.close());
  return service;
};

const kernelFoldsCase = (layout: Layout): boolean => {
  const probe = path.join(layout.root, 'CaseProbe');
  fs.mkdirSync(probe);
  try {
    return fs.statSync(probe).ino === fs.statSync(path.join(layout.root, 'caseprobe')).ino;
  } catch {
    return false;
  } finally {
    fs.rmdirSync(probe);
  }
};

describe('run socket containment under home', () => {
  it('accepts a socket path under a case variant of home', async (context) => {
    const layout = makeLayout();
    if (!kernelFoldsCase(layout)) context.skip();
    const variantHome = path.join(path.dirname(layout.home), path.basename(layout.home).toUpperCase());
    const service = await attempt(layout, layout.socketPath, variantHome);
    expect(service.socketPath).toBe(layout.socketPath);
    expect(fs.lstatSync(layout.socketPath).isSocket()).toBe(true);
  });

  it('rejects a socket path outside home/.momonga', async () => {
    const layout = makeLayout();
    const outside = path.join(layout.root, 'x');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.chmodSync(outside, 0o700);
    await expect(attempt(layout, path.join(outside, 'r.sock'), layout.home)).rejects.toThrow(/\.momonga/);
    expect(fs.existsSync(path.join(outside, 'r.sock'))).toBe(false);
  });
});
