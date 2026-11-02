import { RequestError } from '@agentclientprotocol/sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { availableCommandsOf } from '../src/acp/commands.ts';
import { mcpServersOf } from '../src/acp/mcp-servers.ts';
import { modeStateOf, selectableModeOf } from '../src/acp/modes.ts';

describe('mcpServersOf', () => {
  it('turns stdio and http servers into Run API server configs keyed by name', () => {
    const servers: McpServer[] = [
      { name: 'fx', command: 'node', args: ['server.js', '--flag'], env: [{ name: 'A', value: 'b' }, { name: 'C', value: 'd' }] },
      { type: 'http', name: 'docs', url: 'https://example.com/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
    ];

    expect(mcpServersOf(servers)).toEqual({
      fx: { type: 'stdio', command: 'node', args: ['server.js', '--flag'], env: { A: 'b', C: 'd' } },
      docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    });
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('accepts the server name %s as an ordinary name', (name) => {
    const configs = mcpServersOf([{ name, command: 'node', args: [], env: [] }]);

    expect(Object.keys(configs)).toEqual([name]);
    expect(Object.getOwnPropertyDescriptor(configs, name)?.value).toEqual({ type: 'stdio', command: 'node', args: [], env: {} });
    expect(Object.getPrototypeOf(configs)).toBe(Object.prototype);
  });

  it('returns no servers for an empty list', () => {
    expect(mcpServersOf([])).toEqual({});
  });

  it.each([
    ['an sse server', [{ type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] }]],
    [
      'a name given twice',
      [
        { name: 'fx', command: 'a', args: [], env: [] },
        { name: 'fx', command: 'b', args: [], env: [] },
      ],
    ],
  ] as const)('refuses %s with invalid params', (_label, servers) => {
    expect(() => mcpServersOf(servers as unknown as McpServer[])).toThrow(RequestError);
    try {
      mcpServersOf(servers as unknown as McpServer[]);
    } catch (error) {
      expect((error as RequestError).code).toBe(-32602);
    }
  });
});

describe('modeStateOf', () => {
  it('offers default, acceptEdits and plan, and never auto', () => {
    const state = modeStateOf({ permissionMode: 'acceptEdits', bypassAllowed: false, autoAvailable: false });

    expect(state.currentModeId).toBe('acceptEdits');
    expect(state.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan']);
    for (const mode of state.availableModes) expect(mode.description).toBeTruthy();
  });

  it('adds auto after plan when a classifier is configured', () => {
    const state = modeStateOf({ permissionMode: 'auto', bypassAllowed: false, autoAvailable: true });

    expect(state.currentModeId).toBe('auto');
    expect(state.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
  });

  it('adds bypassPermissions when the session may use it', () => {
    expect(modeStateOf({ permissionMode: 'default', bypassAllowed: true, autoAvailable: false }).availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  });
});

describe('selectableModeOf', () => {
  it('returns a mode the session offers', () => {
    expect(selectableModeOf({ bypassAllowed: false, autoAvailable: false }, 'plan')).toBe('plan');
    expect(selectableModeOf({ bypassAllowed: true, autoAvailable: false }, 'bypassPermissions')).toBe('bypassPermissions');
  });

  it.each([
    [{ bypassAllowed: false, autoAvailable: false }, 'bypassPermissions'],
    [{ bypassAllowed: true, autoAvailable: false }, 'auto'],
    [{ bypassAllowed: true, autoAvailable: false }, 'nonsense'],
  ])('refuses %j %s with invalid params', (source, modeId) => {
    expect(() => selectableModeOf(source, modeId)).toThrow(RequestError);
    expect(() => selectableModeOf(source, modeId)).toThrow(`the mode ${modeId} is not available in this session`);
  });
});

describe('availableCommandsOf', () => {
  it('announces each skill under its name with its description', () => {
    expect(
      availableCommandsOf([
        { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/w/.agents/skills/pdf/SKILL.md' },
        { name: 'deploy', description: 'Ship it', scope: 'user', location: '/h/.agents/skills/deploy/SKILL.md' },
      ]),
    ).toEqual([
      { name: 'pdf', description: 'Extract PDF text' },
      { name: 'deploy', description: 'Ship it' },
    ]);
  });

  it('announces nothing when there are no skills', () => {
    expect(availableCommandsOf([])).toEqual([]);
  });
});
