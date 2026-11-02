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
    const state = modeStateOf({ permissionMode: 'acceptEdits', bypassAllowed: false });

    expect(state.currentModeId).toBe('acceptEdits');
    expect(state.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan']);
    for (const mode of state.availableModes) expect(mode.description).toBeTruthy();
  });

  it('adds bypassPermissions when the session may use it', () => {
    expect(modeStateOf({ permissionMode: 'default', bypassAllowed: true }).availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  });
});

describe('selectableModeOf', () => {
  it('returns a mode the session offers', () => {
    expect(selectableModeOf({ bypassAllowed: false }, 'plan')).toBe('plan');
    expect(selectableModeOf({ bypassAllowed: true }, 'bypassPermissions')).toBe('bypassPermissions');
  });

  it.each([
    [{ bypassAllowed: false }, 'bypassPermissions'],
    [{ bypassAllowed: true }, 'auto'],
    [{ bypassAllowed: true }, 'nonsense'],
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
