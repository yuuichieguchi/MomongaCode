import type { EntryIo } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { createShellPort } from '../src/program.ts';
import type { ShellPort } from '../src/tui/slash.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

const realShell = (context: TestContext): ShellPort => {
  const home = withTempDir(context, { asHome: true });
  const quiet = { write: (): boolean => true };
  const ports = { version: '9.9.9', home, cwd: home, platform: process.platform, env: {}, interrupt: new AbortController().signal, terminal: undefined, stdout: quiet, stderr: quiet } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  return createShellPort({
    ports,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
};

const EMBEDDED_COMMANDS: readonly (readonly string[])[] = [['cost'], ['status'], ['jobs'], ['trace'], ['report'], ['mcp', 'list'], ['context', 'guideline', 'list'], ['policy', 'verify'], ['models'], ['models', 'detect'], ['gateway', 'probe', 'm'], ['daemon', 'status'], ['eval', 'bench', 'tasks']];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a command embedded in the interactive session never ends its host process', () => {
  it('an unknown option and --help of every embedded command return a code, write to the caller, and the next command still runs', async (context) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`the embedded command called process.exit(${String(code)})`);
    });
    const shell = realShell(context);
    const written: string[] = [];
    const io = { write: (text: string): void => void written.push(text), signal: new AbortController().signal };

    for (const command of EMBEDDED_COMMANDS) {
      written.length = 0;
      expect(await shell.run([...command, '--bogus'], io), `${command.join(' ')} --bogus`).toBe(2);
      expect(written.join('')).toContain("unknown option '--bogus'");
      written.length = 0;
      expect(await shell.run([...command, '--help'], io), `${command.join(' ')} --help`).toBe(0);
      expect(written.join('')).toContain('Usage: momonga');
    }

    expect(exit).not.toHaveBeenCalled();
  });

  it('a usage error and a refusal of the command itself return its code with the reason written to the caller, and the next command still runs', async (context) => {
    const shell = realShell(context);
    const written: string[] = [];
    const io = { write: (text: string): void => void written.push(text), signal: new AbortController().signal };

    expect(await shell.run(['cost', 'run-1', '--all'], io)).toBe(2);
    expect(written.join('')).toMatch(/^momonga: /);
    written.length = 0;
    expect(await shell.run(['trace', '--page-size', '5'], io)).toBe(2);
    expect(written.join('')).toContain('momonga: --page-size sets how many stored bodies --content reads per request, so it needs --content');
    written.length = 0;
    expect(await shell.run(['cost', '--help'], io)).toBe(0);
  });

  it('a command interrupted by its caller returns 130 and writes no failure', async (context) => {
    const shell = realShell(context);
    const written: string[] = [];
    const stop = new AbortController();
    stop.abort(new Error('stopped by the person'));

    expect(await shell.run(['gateway', 'probe', 'local/m'], { write: (text) => void written.push(text), signal: stop.signal })).toBe(130);
    expect(written.join('')).toBe('');
  });
});
