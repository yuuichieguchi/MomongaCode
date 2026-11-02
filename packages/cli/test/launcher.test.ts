import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERNAL_COMMANDS, selfInvocation, selfLauncher } from '../src/daemon/launcher.ts';
import { nodeSelf } from '../src/node-ports.ts';
import type { SelfExecutable } from '../src/ports.ts';

const script: SelfExecutable = { kind: 'script', execPath: '/usr/local/bin/node', script: '/opt/momonga/dist/main.js' };
const binary: SelfExecutable = { kind: 'single-binary', execPath: '/usr/local/bin/momonga' };

describe('selfInvocation', () => {
  it('runs the bundled script through the node binary in the dev layout', () => {
    expect(selfInvocation(script, '__gateway', ['--x=1'])).toEqual({ command: '/usr/local/bin/node', args: ['/opt/momonga/dist/main.js', '__gateway', '--x=1'] });
  });

  it('runs the single binary itself with the subcommand as its first argument', () => {
    expect(selfInvocation(binary, '__gateway', ['--x=1'])).toEqual({ command: '/usr/local/bin/momonga', args: ['__gateway', '--x=1'] });
  });
});

describe('selfLauncher', () => {
  it.each([
    ['dev layout', script],
    ['single binary', binary],
  ])('resolves both roles to the same executable and an absolute command in the %s', (_label, self) => {
    const launcher = selfLauncher(self);
    const gateway = launcher('gateway');
    const runtime = launcher('runtime');
    expect(gateway.command).toBe(self.execPath);
    expect(runtime.command).toBe(self.execPath);
    expect(path.isAbsolute(gateway.command)).toBe(true);
    expect(gateway.args.at(self.kind === 'script' ? 1 : 0)).toBe(INTERNAL_COMMANDS.gateway);
    expect(runtime.args.at(self.kind === 'script' ? 1 : 0)).toBe(INTERNAL_COMMANDS.runtime);
  });
});

describe('nodeSelf', () => {
  it('uses the entry script of the process outside a single binary and resolves it', () => {
    expect(nodeSelf(['/usr/local/bin/node', 'dist/main.js'], () => false)).toEqual({
      kind: 'script',
      execPath: process.execPath,
      script: path.resolve('dist/main.js'),
    });
  });

  it('uses only the executable inside a single binary, where argv[1] is not a script', () => {
    expect(nodeSelf(['/x/momonga', '/x/momonga'], () => true)).toEqual({ kind: 'single-binary', execPath: process.execPath });
  });

  it('refuses to guess an entry script when argv has none', () => {
    expect(() => nodeSelf(['/usr/local/bin/node'], () => false)).toThrow('process.argv[1] is empty');
  });
});
