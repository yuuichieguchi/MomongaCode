import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultProtectedPaths } from '@momonga/sandbox';
import { buildSandboxPolicy, createBuiltinTools, createToolRegistry, protectedPathsFor } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { makeBuiltins } from './fixtures.ts';

const NAMES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'ReadOutput', 'UpdatePlan'];

describe('createBuiltinTools', () => {
  it('returns the eight tools in order', () => {
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
      ['ReadOutput', 'read', 'read_only', 10_000],
      ['UpdatePlan', 'think', 'read_only', 5_000],
    ]);
    const bash = tools.find((tool: AnyTool) => tool.name === 'Bash');
    expect([bash?.kind, bash?.sideEffect]).toEqual(['execute', 'exec']);
    const timeoutOf = bash?.timeoutMs as (input: unknown) => number;
    expect(timeoutOf({ command: 'x' })).toBe(120_000);
    expect(timeoutOf({ command: 'x', timeout: 5000 })).toBe(5000);
    expect(timeoutOf({ command: 'x', timeout: 600_000 })).toBe(600_000);
  });

  it('registers every schema under the strict registry', async () => {
    const registry = createToolRegistry();
    for (const tool of createBuiltinTools()) registry.register(tool);
    const toolSet = await registry.snapshot();
    expect(toolSet.tools.map((tool: AnyTool) => tool.name)).toEqual(NAMES);
    expect(toolSet.forModel({ mode: 'default', rules: [] }).map((tool) => tool.name)).toEqual(NAMES);
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
      Bash: ['command', 'description', 'timeout'],
      ReadOutput: ['handle', 'limit', 'offset'],
      UpdatePlan: ['entries'],
    });
  });

  it('sends every tool through createToolExecutor', async () => {
    const tools = await makeBuiltins();
    const file = tools.write('a.txt', 'a\n');
    const [read, glob, plan] = await tools.executor.runBatch(
      tools.input(tools.toolSet, [
        { callId: 'r', name: 'Read', arguments: JSON.stringify({ file_path: file }) },
        { callId: 'g', name: 'Glob', arguments: JSON.stringify({ pattern: '*.txt' }) },
        { callId: 'p', name: 'UpdatePlan', arguments: JSON.stringify({ entries: [{ content: 'x', status: 'pending', priority: 'low' }] }) },
      ], { sandboxPolicy: tools.sandboxPolicy }),
    );
    expect(read).toMatchObject({ kind: 'result', result: { status: 'completed', output: '     1\ta' } });
    expect(glob).toMatchObject({ kind: 'result', result: { status: 'completed', output: file } });
    expect(plan).toMatchObject({ kind: 'result', result: { status: 'completed', output: 'Plan updated (1 entries)' } });
  });
});

describe('protectedPathsFor', () => {
  it('concatenates the default protected paths of every root', () => {
    expect(protectedPathsFor(['/w/a', '/w/b'])).toEqual([...defaultProtectedPaths('/w/a'), ...defaultProtectedPaths('/w/b')]);
  });
});

describe('buildSandboxPolicy', () => {
  const sortedWriteDenied = (policy: { writeDenied: readonly string[] }): string[] => [...policy.writeDenied].sort();

  it('builds writable roots, protected writes and default read denials', () => {
    const policy = buildSandboxPolicy({ roots: ['/w/a', '/w/b'], home: '/Users/me', tmpDir: '/s/sessions/one', sessionsTmpRoot: '/s/sessions' });
    expect({ ...policy, writeDenied: sortedWriteDenied(policy) }).toEqual({
      writableRoots: ['/w/a', '/w/b', '/s/sessions/one'],
      writeDenied: [...protectedPathsFor(['/w/a', '/w/b']), '/Users/me/.momonga', '/Users/me/Library/Keychains', '/s/sessions'].sort(),
      readDenied: [path.join('/Users/me', '.momonga'), path.join('/Users/me', 'Library', 'Keychains'), '/s/sessions'],
      readAllowed: ['/s/sessions/one'],
      network: 'deny',
    });
  });

  it('appends extra writable and read-denied paths and honors the network setting', () => {
    const policy = buildSandboxPolicy({
      roots: ['/w/a'],
      home: '/h',
      tmpDir: '/s/sessions/one',
      sessionsTmpRoot: '/s/sessions',
      network: 'allow',
      extraWritable: ['/cache'],
      extraReadDenied: ['/h/.ssh'],
    });
    expect({ ...policy, writeDenied: sortedWriteDenied(policy) }).toEqual({
      writableRoots: ['/w/a', '/s/sessions/one', '/cache'],
      writeDenied: [...defaultProtectedPaths('/w/a'), '/h/.momonga', '/h/Library/Keychains', '/s/sessions'].sort(),
      readDenied: ['/h/.momonga', '/h/Library/Keychains', '/s/sessions', '/h/.ssh'],
      readAllowed: ['/s/sessions/one'],
      network: 'allow',
    });
  });
});
