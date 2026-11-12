import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalDigestOf, hookGroupApprovalDigestOf } from '@momonga/config';
import { expectSchema, startService } from './helpers.ts';

const GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/check.sh' }] };

const items = (folder: string): string => `/v1/trust/items?path=${encodeURIComponent(folder)}`;

const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

describe('GET /v1/trust/items: what a trusted folder could make the product run that is not approved', () => {
  it('answers the hook groups and the mandate file of a trusted folder that wait for an approval, from the settings loader', async () => {
    const env = await startService({ fakeTimers: true });
    const folder = env.layout.projectReal;
    const settings = path.join(folder, '.momonga', 'settings.json');
    writeJson(settings, { hooks: { PreToolUse: [GROUP] } });
    writeJson(path.join(folder, '.momonga', 'mandate.json'), { steps: 5 });
    expect((await env.http('PUT', '/v1/trust', { body: { path: folder, decision: 'trusted' } })).status).toBe(200);
    const response = await env.http('GET', items(folder));
    expect(response.status).toBe(200);
    expectSchema('TrustItemsResponse', response.json);
    expect(response.json).toEqual({
      items: [
        { kind: 'hook', event: 'PreToolUse', group: GROUP, digest: hookGroupApprovalDigestOf('PreToolUse', GROUP), source: settings, change: { kind: 'new' } },
        { kind: 'mandate', document: { steps: 5 }, digest: expect.stringMatching(/^[0-9a-f]{64}$/), source: path.join(folder, '.momonga', 'mandate.json'), change: { kind: 'new' } },
      ],
      refused: [],
    });
  });

  it('answers nothing for a folder that is not trusted', async () => {
    const env = await startService({ fakeTimers: true });
    writeJson(path.join(env.layout.projectReal, '.momonga', 'settings.json'), { hooks: { PreToolUse: [GROUP] } });
    const response = await env.http('GET', items(env.layout.projectReal));
    expect(response.json).toEqual({ items: [], refused: [] });
  });

  it('answers the sentence of the loader for a settings file it refuses, as data', async () => {
    const env = await startService({ fakeTimers: true });
    const folder = env.layout.projectReal;
    const settings = path.join(folder, '.momonga', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"hooks": ');
    expect((await env.http('PUT', '/v1/trust', { body: { path: folder, decision: 'trusted' } })).status).toBe(200);
    const response = await env.http('GET', items(folder));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ items: [], refused: [expect.stringContaining(settings)] });
  });

  it('answers a changed mandate file with the diff of the approved document against the file now', async () => {
    const env = await startService({ fakeTimers: true });
    const folder = env.layout.projectReal;
    const approved = { steps: 5 };
    writeJson(path.join(env.layout.home, '.momonga', 'settings.json'), { projectApprovals: { [folder]: { mandate: { digest: approvalDigestOf(approved), document: approved } } } });
    writeJson(path.join(folder, '.momonga', 'mandate.json'), { steps: 50 });
    expect((await env.http('PUT', '/v1/trust', { body: { path: folder, decision: 'trusted' } })).status).toBe(200);
    const response = await env.http('GET', items(folder));
    expectSchema('TrustItemsResponse', response.json);
    expect(response.json).toMatchObject({
      items: [{ kind: 'mandate', change: { kind: 'changed', diff: { hunks: [{ lines: expect.arrayContaining(['-  "steps": 5', '+  "steps": 50']) }], added: 1, removed: 1 } } }],
    });
  });

  it('answers an MCP server of .mcp.json that waits for an approval', async () => {
    const env = await startService({ fakeTimers: true });
    const folder = env.layout.projectReal;
    writeJson(path.join(folder, '.mcp.json'), { mcpServers: { docs: { command: 'npx', args: ['docs-server'] } } });
    expect((await env.http('PUT', '/v1/trust', { body: { path: folder, decision: 'trusted' } })).status).toBe(200);
    const response = await env.http('GET', items(folder));
    expectSchema('TrustItemsResponse', response.json);
    expect(response.json).toMatchObject({ items: [{ kind: 'mcp', name: 'docs', config: { command: 'npx', args: ['docs-server'] }, source: path.join(folder, '.mcp.json'), change: { kind: 'new' } }] });
  });
});
