import { describe, expect, it } from 'vitest';
import { SMALL_FILESYSTEM_MAX_BYTES, SMALL_FS_ENV, detectInjectionHost } from './inject-host.ts';
import type { InjectionHostPorts } from './inject-host.ts';

const OWNER = 1001;
const DIRECTORY = '/small-fs';

const portsOf = (overrides: Partial<InjectionHostPorts> = {}): InjectionHostPorts => ({
  platform: 'linux',
  smallFs: DIRECTORY,
  uid: OWNER,
  stat: () => ({ isDirectory: true, uid: OWNER }),
  statfs: () => ({ blocks: SMALL_FILESYSTEM_MAX_BYTES / 4096, bsize: 4096 }),
  ...overrides,
});

describe('the injection host: the size-limited directory is the one named by the variable', () => {
  it('is a Linux container with that directory when the variable names an owned directory on a small filesystem', () => {
    expect(detectInjectionHost(portsOf())).toEqual({ linuxContainer: true, smallFsBase: DIRECTORY });
  });

  it('is not a container when the variable is unset, and the reason names the variable', () => {
    const host = detectInjectionHost(portsOf({ smallFs: undefined }));
    expect(host).toMatchObject({ linuxContainer: false });
    expect(host.linuxContainer ? '' : host.reason).toContain(SMALL_FS_ENV);
  });

  it('is not a container when the filesystem of the directory is larger than the limit', () => {
    const host = detectInjectionHost(portsOf({ statfs: () => ({ blocks: SMALL_FILESYSTEM_MAX_BYTES / 4096 + 1, bsize: 4096 }) }));
    expect(host).toMatchObject({ linuxContainer: false });
    expect(host.linuxContainer ? '' : host.reason).toContain(SMALL_FS_ENV);
  });

  it('is not a container when the directory is owned by another user', () => {
    const host = detectInjectionHost(portsOf({ stat: () => ({ isDirectory: true, uid: 0 }) }));
    expect(host).toMatchObject({ linuxContainer: false });
    expect(host.linuxContainer ? '' : host.reason).toContain('owned by uid 0');
  });

  it('is not a container when the name is not a directory', () => {
    expect(detectInjectionHost(portsOf({ stat: () => ({ isDirectory: false, uid: OWNER }) }))).toMatchObject({ linuxContainer: false });
  });

  it('is not a container on a host that is not Linux', () => {
    expect(detectInjectionHost(portsOf({ platform: 'darwin' }))).toMatchObject({ linuxContainer: false });
  });
});
