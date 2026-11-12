import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerView } from '@momonga/protocol';
import { MCP_ADDRESS_TITLE, MCP_SECRETS_TITLE } from '../../src/tui/commands/mcp.ts';
import { SAVE_TO_TITLE } from '../../src/tui/settings-screen.tsx';
import { contextOf, runSlash } from './slash-context.ts';
import { freshPlace, stored, writeSettings } from './settings-harness.tsx';

const SERVERS: readonly McpServerView[] = [{ name: 'files', scope: 'user', transport: 'stdio', auth: 'not_required' }];
const ADD_STDIO_INDEX = SERVERS.length;
const ADD_HTTP_INDEX = SERVERS.length + 1;

describe('/mcp: a credential of a server is a reference (product-surface-21)', () => {
  it('writes a secret of the secret store as a secretEnv reference, in the user settings', async () => {
    const place = freshPlace();
    const { context, recorded } = contextOf(
      {},
      { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS },
      { choices: [{ index: ADD_STDIO_INDEX, alt: false }], texts: ['github', 'npx', '-y github-server', 'GITHUB_HOST', 'GITHUB_TOKEN=github-token'] },
    );
    await runSlash('mcp', '', context);
    expect(recorded.prompts).toContain(MCP_SECRETS_TITLE);
    expect(recorded.picks.map((pick) => pick.title)).not.toContain(SAVE_TO_TITLE);
    expect(stored(place.userFile)).toEqual({ mcpServers: { github: { type: 'stdio', command: 'npx', args: ['-y', 'github-server'], env: { GITHUB_HOST: '${GITHUB_HOST}' }, secretEnv: { GITHUB_TOKEN: 'github-token' } } } });
  });

  it('refuses a secret entry that is not NAME=secret-name', async () => {
    const place = freshPlace();
    const { context } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS }, { choices: [{ index: ADD_STDIO_INDEX, alt: false }], texts: ['github', 'npx', '', '', undefined] });
    let problem: string | undefined;
    const promptText = context.overlays.promptText;
    await runSlash('mcp', '', {
      ...context,
      overlays: {
        ...context.overlays,
        promptText: async (request) => {
          if (request.title === MCP_SECRETS_TITLE) problem = request.validate('GITHUB_TOKEN');
          return promptText(request);
        },
      },
    });
    expect(problem).toBe('expected NAME=secret-name, got "GITHUB_TOKEN"');
  });
});

describe('/mcp needs no session for the settings (product-surface-26)', () => {
  it('lists the servers of the folder and adds one with no session open', async () => {
    const place = freshPlace();
    const { context, recorded, backend } = contextOf({ model: undefined }, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS }, { choices: [{ index: ADD_HTTP_INDEX, alt: false }], texts: ['tracker', 'https://tracker.example/mcp'] });
    await runSlash('mcp', '', context);
    expect(recorded.infos).toEqual([]);
    expect(recorded.prompts).toContain(MCP_ADDRESS_TITLE);
    expect(backend.calls).toContain('folderMcpServers');
    expect(backend.calls).not.toContain('mcpServers');
    expect(stored(place.userFile)).toEqual({ mcpServers: { tracker: { type: 'http', url: 'https://tracker.example/mcp' } } });
  });
});

describe('/mcp Enable records what the person approved (DECISION-6)', () => {
  it('records { name, digest, config } through the approval writer, the same entry the trust question writes', async () => {
    const place = freshPlace();
    const config = { type: 'http', url: 'https://tracker.example/mcp' };
    fs.writeFileSync(path.join(place.project, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: config } }));
    writeSettings(place.userFile, { disabledMcpjsonServers: ['tracker'] });
    const servers: readonly McpServerView[] = [{ name: 'tracker', scope: 'project', transport: 'http', url: config.url, auth: 'required', approval: { digest: 'a'.repeat(64), changed: false } }];
    const { context, backend } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: servers }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }] });
    await runSlash('mcp', '', context);
    const approved = backend.calls.find((call) => call.startsWith('approve:'));
    expect(approved).toBeDefined();
    const [item] = JSON.parse((approved ?? '').slice('approve:'.length)) as { kind: string; name: string; config: unknown; digest: string }[];
    expect(item).toMatchObject({ kind: 'mcp', name: 'tracker', config });
    expect(item?.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
