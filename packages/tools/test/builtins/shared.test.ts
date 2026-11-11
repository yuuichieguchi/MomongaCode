import { EMPTY_FILE_RULES, defaultProtectedPaths, momongaLayout, standardSecretLocations } from '@momonga/foundation';
import { protectedSetWith, NEVER_CANCELLED } from '@momonga/testkit';
import type { ProtectedSet } from '@momonga/foundation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildSandboxPolicy, createBuiltinTools, createToolRegistry } from '@momonga/tools';
import type { AnyTool, ToolDefinition } from '@momonga/tools';
import type { PermissionRule } from '@momonga/policy';
import { makeLayout, ruleFor } from '../helpers.ts';
import { makeBuiltins } from './fixtures.ts';

const NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillBash', 'ReadOutput', 'UpdatePlan'];
const OFFERED = ['Glob', 'Grep', 'Read', 'ReadOutput', 'Bash', 'BashOutput', 'KillBash', 'Edit', 'UpdatePlan', 'Write'];

type Definition = ToolDefinition<Record<string, unknown>>;

const body = {
  name: 'T',
  description: 'd',
  kind: 'other',
  inputSchema: { type: 'object' },
  timeoutMs: 1,
  title: (): string => 't',
  execute: async (): Promise<{ status: 'completed'; output: string }> => ({ status: 'completed', output: '' }),
} as const;

const noneSubject = (): { kind: 'none'; tool: string } => ({ kind: 'none', tool: 'T' });

describe('the subject a tool declares', () => {
  it('is accepted when it is the kind that subject() returns', () => {
    const declared = { ...body, sideEffect: 'write', subjectKind: 'none', subject: noneSubject } as const;
    expectTypeOf(declared).toExtend<Definition>();
  });

  it('is rejected when it differs from the kind that subject() returns', () => {
    const mismatched = { ...body, sideEffect: 'write', subjectKind: 'path', subject: noneSubject } as const;
    expectTypeOf(mismatched).not.toExtend<Definition>();
  });

  it('is required of a tool that is not read-only', () => {
    const missing = { ...body, sideEffect: 'write', subject: noneSubject } as const;
    expectTypeOf(missing).not.toExtend<Definition>();
  });

  it('may be left out by a read-only tool', () => {
    const readOnly = { ...body, sideEffect: 'read_only', subject: noneSubject } as const;
    expectTypeOf(readOnly).toExtend<Definition>();
  });
});

describe('createBuiltinTools', () => {
  it('returns the ten tools in order', () => {
    expect(createBuiltinTools().map((tool: AnyTool) => tool.name)).toEqual(NAMES);
  });

  it('declares kinds, side effects and timeouts', () => {
    const tools = createBuiltinTools();
    const summary = tools
      .filter((tool: AnyTool) => tool.name !== 'Bash')
      .map((tool: AnyTool) => [tool.name, tool.kind, tool.sideEffect, tool.timeoutMs]);
    expect(summary).toEqual([
      ['Read', 'read', 'read_only', 30_000],
      ['Write', 'edit', 'write', 30_000],
      ['Edit', 'edit', 'write', 30_000],
      ['Glob', 'search', 'read_only', 60_000],
      ['Grep', 'search', 'read_only', 60_000],
      ['BashOutput', 'execute', 'read_only', 10_000],
      ['KillBash', 'execute', 'write', 30_000],
      ['ReadOutput', 'read', 'read_only', 10_000],
      ['UpdatePlan', 'think', 'read_only', 5_000],
    ]);
    const bash = tools.find((tool: AnyTool) => tool.name === 'Bash');
    expect([bash?.kind, bash?.sideEffect]).toEqual(['execute', 'exec']);
    const timeoutOf = bash?.timeoutMs as (input: unknown) => number;
    expect(timeoutOf({ command: 'x' })).toBe(120_000);
    expect(timeoutOf({ command: 'x', timeout: 5000 })).toBe(5000);
    expect(timeoutOf({ command: 'x', timeout: 600_000 })).toBe(600_000);
    expect(timeoutOf({ command: 'x', timeout: 7_200_000, run_in_background: true })).toBe(120_000);
  });

  it('registers every schema under the strict registry', async () => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) registry.register(tool);
    const toolSet = await registry.snapshot();
    expect(toolSet.tools.map((tool: AnyTool) => tool.name)).toEqual(OFFERED);
    expect(toolSet.forModel({ mode: 'manual', rules: [] }).map((tool) => tool.name)).toEqual(OFFERED);
  });

  describe('offering the job tools', () => {
    const JOB_TOOLS = ['BashOutput', 'KillBash'];
    const snapshot = async () => {
      const registry = createToolRegistry();
      for (const tool of createBuiltinTools()) registry.register(tool);
      return registry.snapshot();
    };
    const offered = async (mode: 'manual' | 'plan', rules: PermissionRule[]): Promise<string[]> =>
      (await snapshot()).forModel({ mode, rules }).map((tool) => tool.name);

    it('declares the tool they serve', async () => {
      expect((await snapshot()).companions).toEqual(new Map([['BashOutput', 'Bash'], ['KillBash', 'Bash']]));
    });

    it('are offered with Bash', async () => {
      expect((await offered('manual', [])).filter((name) => JOB_TOOLS.includes(name))).toEqual(JOB_TOOLS);
    });

    it('hides KillBash under its own deny rule', async () => {
      const names = await offered('manual', [ruleFor(makeLayout())('deny', 'KillBash')]);
      expect(names).toContain('BashOutput');
      expect(names).not.toContain('KillBash');
    });

    it('hides KillBash in plan mode, where every call of it is refused, and keeps BashOutput and Bash', async () => {
      const names = await offered('plan', []);
      expect(names).not.toContain('KillBash');
      expect(names).toContain('BashOutput');
      expect(names).toContain('Bash');
    });
  });

  it('uses Claude Code input property names', () => {
    const properties = Object.fromEntries(
      createBuiltinTools().map((tool: AnyTool) => [tool.name, Object.keys((tool.inputSchema['properties'] ?? {}) as Record<string, unknown>).sort()]),
    );
    expect(properties).toEqual({
      Read: ['file_path', 'limit', 'offset'],
      Write: ['content', 'file_path'],
      Edit: ['file_path', 'new_string', 'old_string', 'replace_all'],
      Glob: ['path', 'pattern'],
      Grep: ['-A', '-B', '-C', '-i', '-n', 'glob', 'head_limit', 'multiline', 'offset', 'output_mode', 'path', 'pattern', 'type'],
      Bash: ['command', 'description', 'network', 'run_in_background', 'timeout'],
      BashOutput: ['bash_id', 'block', 'filter', 'timeout'],
      KillBash: ['shell_id'],
      ReadOutput: ['handle', 'limit', 'offset'],
      UpdatePlan: ['entries'],
    });
  });

  it('sends every tool through createToolExecutor', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('a.txt', 'a\n');
    const [read, glob, plan] = await tools.executor.runBatch(
      await tools.input(tools.toolSet, [
        { callId: 'r', name: 'Read', arguments: JSON.stringify({ file_path: file }) },
        { callId: 'g', name: 'Glob', arguments: JSON.stringify({ pattern: '*.txt' }) },
        { callId: 'p', name: 'UpdatePlan', arguments: JSON.stringify({ entries: [{ content: 'x', status: 'pending', priority: 'low' }] }) },
      ], { sandboxPolicy: tools.sandboxPolicy, tmpDir: tools.tmpDir }),
    );
    expect(read).toMatchObject({ kind: 'result', result: { status: 'completed', output: '     1\ta' } });
    expect(glob).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'a.txt' } });
    expect(plan).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'Plan updated (1 entries)' } });
  });
});

describe('buildSandboxPolicy', () => {
  const sortedWriteDenied = (policy: { writeDenied: readonly string[] }): string[] => [...policy.writeDenied].sort();

  it('builds writable roots, protected writes from the protected set and default read denials', async () => {
    const protectedSet = protectedSetWith(['/w/a', '/w/b'], [...defaultProtectedPaths('/w/a'), ...defaultProtectedPaths('/w/b')]);
    const policy = await buildSandboxPolicy({ layout: momongaLayout('/Users/me', process.platform, process.env), protectedSet, fileRules: EMPTY_FILE_RULES, roots: ['/w/a', '/w/b'], home: '/Users/me', tmpDir: '/s/sessions/one', sessionsTmpRoot: '/s/sessions' }, NEVER_CANCELLED);
    expect({ ...policy, writeDenied: sortedWriteDenied(policy) }).toEqual({
      writableRoots: ['/w/a', '/w/b', '/s/sessions/one'],
      writeDenied: [...protectedSet.paths, '/Users/me/.momonga', momongaLayout('/Users/me', process.platform, process.env).keychains, momongaLayout('/Users/me', process.platform, process.env).executables, '/s/sessions'].sort(),
      readDenied: [...standardSecretLocations(momongaLayout('/Users/me', process.platform, process.env)).map((location) => location.directory), '/s/sessions'],
      writeDeniedLiterals: ['/Users/me/.local/bin/momonga'],
      fileRules: EMPTY_FILE_RULES,
      protectedSet,
      readAllowed: ['/s/sessions/one'],
      network: 'deny',
      unixSocketAllow: [],
    });
  });

  it('derives writeDenied from the paths of the set, not from the roots', async () => {
    const protectedSet = protectedSetWith(['/w/a'], ['/w/a/.git', '/w/main/.git/hooks', '/w/main/.git/config']);
    const policy = await buildSandboxPolicy({ layout: momongaLayout('/h', process.platform, process.env), protectedSet, fileRules: EMPTY_FILE_RULES, roots: ['/w/a'], home: '/h', tmpDir: '/s/sessions/one', sessionsTmpRoot: '/s/sessions' }, NEVER_CANCELLED);
    expect(sortedWriteDenied(policy)).toEqual(['/w/a/.git', '/w/main/.git/hooks', '/w/main/.git/config', '/h/.momonga', momongaLayout('/h', process.platform, process.env).keychains, momongaLayout('/h', process.platform, process.env).executables, '/s/sessions'].sort());
    expect(policy.writeDenied).not.toContain('/w/a/.git/hooks');
  });

  it('keeps writeDeniedLiterals to the launcher literals when the set has literals', async () => {
    const protectedSet: ProtectedSet = { ...protectedSetWith(['/w/a'], []), literals: ['/w/a/x'] };
    const policy = await buildSandboxPolicy({ layout: momongaLayout('/h', process.platform, process.env), protectedSet, fileRules: EMPTY_FILE_RULES, roots: ['/w/a'], home: '/h', tmpDir: '/s/sessions/one', sessionsTmpRoot: '/s/sessions' }, NEVER_CANCELLED);
    expect(policy.writeDeniedLiterals).toEqual(['/h/.local/bin/momonga']);
    expect(policy.protectedSet.literals).toEqual(['/w/a/x']);
  });

  it('appends extra writable and read-denied paths and honors the network setting', async () => {
    const protectedSet = protectedSetWith(['/w/a'], defaultProtectedPaths('/w/a'));
    const policy = await buildSandboxPolicy({
      layout: momongaLayout('/h', process.platform, process.env),
      protectedSet,
      fileRules: EMPTY_FILE_RULES,
      roots: ['/w/a'],
      home: '/h',
      tmpDir: '/s/sessions/one',
      sessionsTmpRoot: '/s/sessions',
      network: 'allow',
      extraWritable: ['/cache'],
      extraReadDenied: ['/h/.ssh'],
    }, NEVER_CANCELLED);
    expect({ ...policy, writeDenied: sortedWriteDenied(policy) }).toEqual({
      writableRoots: ['/w/a', '/s/sessions/one', '/cache'],
      writeDenied: [...defaultProtectedPaths('/w/a'), '/h/.momonga', momongaLayout('/h', process.platform, process.env).keychains, momongaLayout('/h', process.platform, process.env).executables, '/s/sessions'].sort(),
      readDenied: [...standardSecretLocations(momongaLayout('/h', process.platform, process.env)).map((location) => location.directory), '/s/sessions', '/h/.ssh'],
      writeDeniedLiterals: ['/h/.local/bin/momonga'],
      fileRules: EMPTY_FILE_RULES,
      protectedSet,
      readAllowed: ['/s/sessions/one'],
      network: 'allow',
      unixSocketAllow: [],
    });
  });
});
