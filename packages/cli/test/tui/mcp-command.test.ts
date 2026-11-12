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

describe('/mcp Enable asks the item question and approves exactly what was shown (DECISION-6, R5)', () => {
  const config = { type: 'http', url: 'https://tracker.example/mcp' };
  const servers: readonly McpServerView[] = [{ name: 'tracker', scope: 'project', transport: 'http', url: config.url, auth: 'required', approval: { digest: 'a'.repeat(64), changed: false } }];

  const placeWith = (written: unknown) => {
    const place = freshPlace();
    fs.writeFileSync(path.join(place.project, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: written } }));
    writeSettings(place.userFile, { disabledMcpjsonServers: ['tracker'] });
    return place;
  };

  const shownItem = async (place: { home: string; project: string }) => {
    const { context } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project } });
    const pending = await context.backend.pendingProjectServer('tracker');
    if (pending?.kind !== 'mcp') throw new Error('the server is not pending');
    return { kind: 'mcp' as const, name: 'tracker', config: pending.config, digest: pending.digest, source: path.join(place.project, '.mcp.json'), change: { kind: 'new' as const } };
  };

  it('shows the item question with the content and approves the shown item with its digest', async () => {
    const place = placeWith(config);
    const item = await shownItem(place);
    const { context, backend, recorded } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: servers, trustItems: { items: [item], refused: [] } }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }, { index: 0, alt: false }] });
    await runSlash('mcp', '', context);
    expect(recorded.picks.map((pick) => pick.title)).toContain('The MCP server tracker of this folder is new');
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual([`approve:${JSON.stringify([{ kind: 'mcp', name: 'tracker', config: item.config, digest: item.digest }])}`]);
  });

  it('asks about the disabled server by its name and, on Not now, leaves it disabled with no settings write', async () => {
    const place = placeWith(config);
    const item = await shownItem(place);
    const { context, backend } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: servers, trustItems: { items: [item], refused: [] } }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }, { index: 1, alt: false }] });
    await runSlash('mcp', '', context);
    expect(backend.calls).toContain('trustItems:tracker');
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual([]);
    expect(stored(place.userFile)).toEqual({ disabledMcpjsonServers: ['tracker'] });
  });

  it('changes the disabled list only through the approval itself', async () => {
    const place = placeWith(config);
    const item = await shownItem(place);
    const { context, backend } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: servers, trustItems: { items: [item], refused: [] } }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }, { index: 0, alt: false }] });
    await runSlash('mcp', '', context);
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toHaveLength(1);
    expect(stored(place.userFile)).toEqual({ disabledMcpjsonServers: ['tracker'] });
  });

  it('approves nothing when the file changed between the question and the approval, and asks again', async () => {
    const place = placeWith(config);
    const item = await shownItem(place);
    fs.writeFileSync(path.join(place.project, '.mcp.json'), JSON.stringify({ mcpServers: { tracker: { type: 'http', url: 'https://evil.example/mcp' } } }));
    const { context, backend, recorded } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: servers, trustItems: { items: [item], refused: [] } }, { choices: [{ index: 0, alt: false }, { index: 0, alt: false }, { index: 0, alt: false }] });
    await runSlash('mcp', '', context);
    expect(backend.calls.filter((call) => call.startsWith('approve:'))).toEqual([]);
    expect(recorded.picks.filter((pick) => pick.title === 'The MCP server tracker of this folder is new')).toHaveLength(2);
  });
});
