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

  it.each([['constructor', 'constructor'], ['toString', 'tostring'], ['__proto__', 'proto'], ['hasOwnProperty', 'hasownproperty']])('accepts the server name %s as an ordinary name, keyed %s', (name, key) => {
    const configs = mcpServersOf([{ name, command: 'node', args: [], env: [] }]);

    expect(Object.keys(configs)).toEqual([key]);
    expect(Object.getOwnPropertyDescriptor(configs, key)?.value).toEqual({ type: 'stdio', command: 'node', args: [], env: {} });
    expect(Object.getPrototypeOf(configs)).toBe(Object.prototype);
  });

  it('keys a label by the one server key rule, and a repeated label gets a distinct key', () => {
    const configs = mcpServersOf([
      { name: 'Sequential Thinking', command: 'a', args: [], env: [] },
      { name: 'fx', command: 'b', args: [], env: [] },
      { name: 'fx', command: 'c', args: [], env: [] },
    ]);
    expect(Object.keys(configs)).toEqual(['sequential-thinking', 'fx', 'fx-2']);
  });

  it('refuses a label with no letter or digit with the sentence that names it', () => {
    expect(() => mcpServersOf([{ name: '@/.', command: 'a', args: [], env: [] }])).toThrow('the MCP server "@/." has no letter or digit to make a server name from; give it a name with one');
  });

  it('returns no servers for an empty list', () => {
    expect(mcpServersOf([])).toEqual({});
  });

  it.each([
    ['an sse server', [{ type: 'sse', name: 'legacy', url: 'https://example.com/sse', headers: [] }]],
    ['a name with no letter or digit', [{ name: '@/.', command: 'a', args: [], env: [] }]],
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
    expect(state.availableModes.map((mode) => mode.id)).toEqual(['manual', 'acceptEdits', 'plan']);
    for (const mode of state.availableModes) expect(mode.description).toBeTruthy();
  });

  it('adds auto after plan when a classifier is configured', () => {
    const state = modeStateOf({ permissionMode: 'auto', bypassAllowed: false, autoAvailable: true });

    expect(state.currentModeId).toBe('auto');
    expect(state.availableModes.map((mode) => mode.id)).toEqual(['manual', 'acceptEdits', 'plan', 'auto']);
  });

  it('adds bypassPermissions when the session may use it', () => {
    expect(modeStateOf({ permissionMode: 'manual', bypassAllowed: true, autoAvailable: false }).availableModes.map((mode) => mode.id)).toEqual(['manual', 'acceptEdits', 'plan', 'bypassPermissions']);
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

describe('the ACP mode ids are the mode names (design 8.2 row 15)', () => {
  it('lists manual first, named Manual, with the descriptions of the one table', () => {
    const state = modeStateOf({ permissionMode: 'manual', bypassAllowed: true, autoAvailable: true });
    expect(state.currentModeId).toBe('manual');
    expect(state.availableModes).toEqual([
      { id: 'manual', name: 'manual', description: 'asks before every file change and command' },
      { id: 'acceptEdits', name: 'acceptEdits', description: 'accepts file edits inside the workspace, asks before commands' },
      { id: 'plan', name: 'plan', description: 'read-only tools, the agent proposes a plan' },
      { id: 'auto', name: 'auto', description: 'an automatic classifier decides which calls are allowed' },
      { id: 'bypassPermissions', name: 'bypassPermissions', description: 'runs every tool without asking' },
    ]);
  });

  it('refuses the mode id default like any unknown id', () => {
    expect(selectableModeOf({ bypassAllowed: true, autoAvailable: true }, 'manual')).toBe('manual');
    expect(() => selectableModeOf({ bypassAllowed: true, autoAvailable: true }, 'default')).toThrow('the mode default is not available in this session');
  });
});
