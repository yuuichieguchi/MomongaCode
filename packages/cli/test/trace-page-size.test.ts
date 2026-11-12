import type { EntryIo } from '@momonga/foundation';
import { MAX_TRACE_CONTENT_PAGE, TRACE_CONTENT_PAGE_OPTION } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, exitOfFailure } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { NO_HELPER } from './no-helper.ts';

const traceCommand = (written: string[]) => {
  const sink = { write: (text: string): boolean => (written.push(text), true) };
  const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined, stdout: sink, stderr: sink } as unknown as CliPorts;
  const entry = async (): Promise<number> => 0;
  const program = buildProgram({
    ports,
    entries: { supervise: entry, gateway: entry, runtime: entry },
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  const trace = program.commands.find((command) => command.name() === 'trace');
  if (trace === undefined) throw new Error('the trace command is not registered');
  return { program, trace, ports };
};

const exitOf = async (argv: readonly string[]): Promise<{ code: number | undefined; written: string }> => {
  const written: string[] = [];
  const { program, ports } = traceCommand(written);
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    return { code: exitOfFailure(error, ports.stderr), written: written.join('') };
  }
  return { code: undefined, written: written.join('') };
};

describe('momonga trace --content --page-size', () => {
  it('is documented with its bounds and the default the command uses', () => {
    const option = traceCommand([]).trace.options.find((candidate) => candidate.long === TRACE_CONTENT_PAGE_OPTION.flag);
    expect(option?.description).toContain(`from ${TRACE_CONTENT_PAGE_OPTION.minimum} to ${TRACE_CONTENT_PAGE_OPTION.maximum}`);
    expect(option?.description).toContain(`${TRACE_CONTENT_PAGE_OPTION.default} when omitted`);
    expect(option?.defaultValue).toBe(MAX_TRACE_CONTENT_PAGE);
  });

  it.each(['0', String(MAX_TRACE_CONTENT_PAGE + 1), '2.5', 'many'])('refuses %s as a usage error that names the bounds', async (given) => {
    const result = await exitOf(['trace', 'run-1', '--content', '--page-size', given]);
    expect(result.code).toBe(2);
    expect(result.written).toContain(`expected an integer from ${TRACE_CONTENT_PAGE_OPTION.minimum} to ${TRACE_CONTENT_PAGE_OPTION.maximum}`);
  });

  it('is refused by name without --content, which is the only form that reads pages', async () => {
    const result = await exitOf(['trace', 'run-1', '--page-size', '10']);
    expect(result.code).toBe(2);
    expect(result.written).toContain('--page-size');
    expect(result.written).toContain('--content');
  });
});
