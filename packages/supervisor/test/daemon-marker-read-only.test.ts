import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDaemonMarker } from '../src/orphans.ts';

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the daemon marker descriptor the supervisor hands to a child', () => {
  it('is read-only: a write through it fails with EBADF', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-daemon-ro-')));
    created.push(dir);
    const marker = openDaemonMarker(dir, 'runtime');
    let code = 'written';
    try {
      fs.writeSync(marker.fd, 'x');
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    } finally {
      marker.closeFd();
    }
    expect(code).toBe('EBADF');
    expect(fs.readFileSync(marker.path, 'utf8')).toBe('');
  });
});
