import { describe, expect, it } from 'vitest';
import { commandSpecsFor, systemProgramDirectories, userlandOf } from '../src/platform-specs.ts';
import { scanSedScript } from '../src/sed-script.ts';
import { commandRow, kindIn } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';

const linux: Pick<Row, 'fs'> = { fs: () => ({ platform: 'linux' }) };
const darwin: Pick<Row, 'fs'> = { fs: () => ({ platform: 'darwin' }) };

describe('command specifications are keyed by platform (finding 9)', () => {
  it('uses the GNU specifications on Linux and Windows and the BSD ones on macOS and the BSDs', () => {
    expect(userlandOf('linux')).toBe('gnu');
    expect(userlandOf('win32')).toBe('gnu');
    expect(userlandOf('darwin')).toBe('bsd');
    expect(userlandOf('freebsd')).toBe('bsd');
    expect(commandSpecsFor('linux').specOf('sed')?.dialect).toBe('gnu');
    expect(commandSpecsFor('darwin').specOf('sed')?.dialect).toBe('bsd');
  });

  it('treats /bin and /usr/bin as the system program directories on Darwin and Linux only', () => {
    expect(systemProgramDirectories('darwin')).toEqual(['/bin', '/usr/bin']);
    expect(systemProgramDirectories('linux')).toEqual(['/bin', '/usr/bin']);
    expect(systemProgramDirectories('win32')).toEqual([]);
  });

  it('declares the same approvable program names on both families, except ps, which macOS cannot run in a sandbox', () => {
    const names = (platform: NodeJS.Platform) =>
      commandSpecsFor(platform)
        .all.filter((spec) => spec.approval !== undefined)
        .flatMap((spec) => spec.names)
        .sort();
    expect(names('linux').filter((name) => name !== 'ps')).toEqual(names('darwin'));
    expect(names('linux')).toContain('ps');
    expect(names('darwin')).not.toContain('ps');
  });

  it('GNU options keep their documented arity: -D and -t are flags for ls and stat, -S is not a grep option', () => {
    const gnu = commandSpecsFor('linux');
    expect(gnu.specOf('ls')?.declOf('-D')?.takes).toBe('none');
    expect(gnu.specOf('stat')?.declOf('-t')?.takes).toBe('none');
    expect(gnu.specOf('stat')?.declOf('-f')?.takes).toBe('none');
    expect(gnu.specOf('grep')?.declOf('-S')).toBeUndefined();
    expect(gnu.specOf('grep')?.effectOf('-R')).toBe('follows-symlinks');
    expect(gnu.specOf('ls')?.declOf('-D')?.takes).not.toBe(commandSpecsFor('darwin').specOf('ls')?.declOf('-D')?.takes);
  });
});

describe('decisions follow the platform of the filesystem port', () => {
  it.each([
    ['grep -R x .', 'ask', 'allow'],
    ['ls -D /etc/passwd', 'ask', 'allow'],
    ['stat -t /etc/passwd', 'ask', 'allow'],
    ['grep --dereference-recursive x .', 'ask', 'ask'],
  ] as const)('%s asks on Linux where GNU reads the operand, and is %s on macOS', async (command, onLinux, onDarwin) => {
    expect(await kindIn(commandRow(command, linux), 'manual')).toBe(onLinux);
    expect(await kindIn(commandRow(command, darwin), 'manual')).toBe(onDarwin);
  });

  it('sed -i takes no value on GNU, so the file after the script is the write target', async () => {
    expect(await kindIn(commandRow('sed -i p .envrc', { ...linux, protection: true }), 'acceptEdits')).toBe('prot');
    expect(await kindIn(commandRow('sed -i p f', linux), 'acceptEdits')).toBe('allow');
    expect(await kindIn(commandRow('sed -i p f', linux), 'manual')).toBe('ask');
    expect(await kindIn(commandRow("sed -i.bak p f", linux), 'acceptEdits')).toBe('allow');
    expect(await kindIn(commandRow("sed --in-place=bak/* p f", linux), 'acceptEdits')).toBe('ask');
  });

  it('GNU sed -i with the script file as the last operand is the protected file', async () => {
    expect(await kindIn(commandRow('sed --in-place -e p .envrc', { ...linux, protection: true }), 'acceptEdits')).toBe('prot');
    expect(await kindIn(commandRow("sed -n -i p .envrc", { ...linux, protection: true }), 'acceptEdits')).toBe('prot');
  });

  it('allows the common GNU read-only forms on Linux', async () => {
    for (const command of ['ls -la --color=auto', 'cat -n f', 'head -n 5 f', 'tail -n 5 f', 'grep -rn --include=*.ts x .', 'wc -l f', 'stat -c %s f', 'du -sh .', 'find . -name x -type f', 'sort -u f', 'diff -u f m', 'ps aux', 'ps -ef']) {
      expect(await kindIn(commandRow(command, { ...linux }), 'manual'), command).toBe('allow');
    }
  });

  it('asks for GNU forms that write, execute or follow links', async () => {
    for (const command of ['sort -o out f', 'find . -delete', 'find . -fprint out', 'find . -exec rm {} ;', 'ls -L', 'du -L .', 'tail -f f --pid=1 -s 1 --unknown', 'ps aux -e', 'ps -E', 'sed -f s.sed f', 'sed --file=s.sed f']) {
      expect(await kindIn(commandRow(command, { ...linux }), 'manual'), command).toBe('ask');
    }
  });

  it('does not treat /usr/bin on Windows as a system directory', async () => {
    expect(await kindIn(commandRow('ls', { fs: () => ({ platform: 'win32' }) }), 'manual')).toBe('ask');
  });
});

describe('GNU sed scripts are scanned with and without bracket awareness', () => {
  it('agrees on a plain script', () => {
    expect(scanSedScript('s/a/b/;p', 'gnu').simple).toBe(true);
  });

  it('refuses a script whose delimiter sits inside a bracket expression, where the two readings differ', () => {
    expect(scanSedScript('s/[/]/x/', 'bsd').simple).toBe(true);
    expect(scanSedScript('s/[/]/x/', 'gnu').simple).toBe(false);
  });
});
