import { describe, expect, it } from 'vitest';
import { assertMcpServer, assertMcpServersFile, assertSettings } from '../src/settings.ts';

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('no error was thrown');
};

const SHAPE = /^(?<file>\S+): invalid settings at (?<pointer>\/\S*): (?<reason>.+)$/u;

const partsOf = (message: string): { file: string; pointer: string; reason: string } => {
  const match = SHAPE.exec(message);
  if (match?.groups === undefined) throw new Error(`not in the one form: ${message}`);
  return { file: match.groups['file'] as string, pointer: match.groups['pointer'] as string, reason: match.groups['reason'] as string };
};

describe('settings messages name the file, the pointer and the reason in one form', () => {
  it.each([
    ['tui', { tui: { theme: 'bogus' } }, '/tui/theme', /must be one of .*; got "bogus"/u],
    ['stop', { gateway: { closeGraceMs: -1 } }, '/gateway/closeGraceMs', /must be an integer from \d+ to \d+ milliseconds; got -1/u],
    ['runtime stop', { runtime: { drainTimeoutMs: 'x' } }, '/runtime/drainTimeoutMs', /must be an integer/u],
    ['mcp timeout', { mcp: { connectTimeoutMs: 0 } }, '/mcp/connectTimeoutMs', /must be an integer from 1 to \d+ milliseconds; got 0/u],
    ['schema', { permissions: { defaultMode: 'nope' } }, '/permissions/defaultMode', /./u],
    ['tools', { tools: 5 }, '/tools', /./u],
  ])('%s', (_kind, value, pointer, reason) => {
    const parts = partsOf(messageOf(() => assertSettings(value, '/home/u/.momonga/settings.json')));
    expect(parts.file).toBe('/home/u/.momonga/settings.json');
    expect(parts.pointer).toBe(pointer);
    expect(parts.reason).toMatch(reason);
    expect(parts.reason).not.toContain(pointer.slice(1).replaceAll('/', '.'));
  });

  it('a file with more than one error names the count of the others and the first key', () => {
    const message = messageOf(() => assertSettings({ permissions: { defaultMode: 'nope' }, tools: 5, forges: 3 }, 'settings.json'));
    const parts = partsOf(message);
    expect(parts.file).toBe('settings.json');
    expect(['/permissions/defaultMode', '/tools', '/forges']).toContain(parts.pointer);
    expect(parts.reason).toMatch(/\(and 2 more errors\)$/u);
  });

  it('a file with one error names no count', () => {
    expect(messageOf(() => assertSettings({ tools: 5 }, 'settings.json'))).not.toMatch(/more error/u);
  });

  it('the MCP server file and one MCP server use the same form', () => {
    expect(partsOf(messageOf(() => assertMcpServersFile({ mcpServers: 3 }, '.mcp.json'))).pointer).toBe('/mcpServers');
    const server = partsOf(messageOf(() => assertMcpServer({ type: 'stdio', command: 3 }, '.mcp.json', 'files')));
    expect(server.pointer).toBe('/mcpServers/files/command');
  });
});
