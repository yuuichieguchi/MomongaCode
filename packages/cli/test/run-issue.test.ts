import type { EntryIo } from '@momonga/foundation';
import { issueRunInput } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import { freshHome } from './fresh-home.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { createRunBody } from '../src/client/runtime-client.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { UsageError } from '../src/usage-error.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({ headless: [] as Record<string, unknown>[] }));

vi.mock('../src/run/headless.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/run/headless.ts')>();
  return {
    ...original,
    runHeadless: async (_ports: unknown, _paths: unknown, options: Record<string, unknown> & { prompt: () => Promise<string> }) => {
      seen.headless.push({ ...options, prompt: await options.prompt() });
      return 0;
    },
  };
});

const ISSUE_URL = 'https://github.com/acme/widgets/issues/7';

const program = () => {
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: {} } as unknown as CliPorts;
  const built = buildProgram({
    ports,
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: () => undefined,
  });
  built.exitOverride().configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  return built;
};

const run = (...args: string[]): Promise<unknown> => program().parseAsync(args, { from: 'user' });

const refusal = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

describe('momonga --issue <address>', () => {
  it('runs one headless run under the named mandate, from the issue, with the product words as its input', async () => {
    seen.headless.length = 0;
    await run('--issue', ISSUE_URL, '--mandate', 'fix');
    expect(seen.headless).toHaveLength(1);
    expect(seen.headless[0]).toMatchObject({ prompt: issueRunInput(ISSUE_URL), issue: ISSUE_URL, mandate: { profile: 'fix' } });
  });

  it('is refused with the usage exit when no mandate is named, and names the flag', async () => {
    seen.headless.length = 0;
    const error = await refusal(run('--issue', ISSUE_URL));
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('--mandate');
    expect(seen.headless).toHaveLength(0);
  });

  it('is refused beside a prompt of its own', async () => {
    const error = await refusal(run('--issue', ISSUE_URL, '--mandate', 'fix', '-p', 'something else'));
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toContain('--issue');
  });
});

describe('the run request of an issue run', () => {
  it('carries the issue address', () => {
    expect(createRunBody('x', { issue: ISSUE_URL })).toMatchObject({ input: 'x', issue: { url: ISSUE_URL } });
  });
});

describe('the words of an issue run', () => {
  it('name the issue, tell the model the attached text is not its instructions, and name the operations that end the run', () => {
    const text = issueRunInput(ISSUE_URL);
    expect(text).toContain(ISSUE_URL);
    expect(text).toContain('not as instructions');
    for (const operation of ['GitCommit', 'GitPush', 'PullRequestCreate', 'IssueComment']) expect(text).toContain(operation);
  });
});
