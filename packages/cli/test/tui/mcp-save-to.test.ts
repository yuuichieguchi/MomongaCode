import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerView } from '@momonga/protocol';
import { SAVE_TO_TITLE } from '../../src/tui/settings-screen.tsx';
import { contextOf, runSlash } from './slash-context.ts';
import { freshPlace, stored } from './settings-harness.tsx';

const SERVERS: readonly McpServerView[] = [];
const ADD_HTTP_INDEX = 1;
const TRACKER = { type: 'http', url: 'https://tracker.example/mcp' };

describe('/mcp writes to the place Save to names (cli-tui-C41)', () => {
  it('offers the user settings and the folder .mcp.json in a trusted folder, never local', async () => {
    const place = freshPlace();
    const { context, recorded } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS }, { choices: [{ index: ADD_HTTP_INDEX, alt: false }, undefined], texts: ['tracker', TRACKER.url] });
    await runSlash('mcp', '', context);
    const saveTo = recorded.picks.find((pick) => pick.title === SAVE_TO_TITLE);
    expect(saveTo?.rows.map((row) => row.label)).toEqual(['user', 'project']);
  });

  it('writes .mcp.json when project is chosen and approves the content written, so it is not asked about again', async () => {
    const place = freshPlace();
    const { context, backend } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS }, { choices: [{ index: ADD_HTTP_INDEX, alt: false }, { index: 1, alt: false }], texts: ['tracker', TRACKER.url] });
    await runSlash('mcp', '', context);
    expect(JSON.parse(fs.readFileSync(path.join(place.project, '.mcp.json'), 'utf8'))).toEqual({ mcpServers: { tracker: TRACKER } });
    expect(stored(place.userFile)).toMatchObject({ enabledMcpjsonServers: [{ name: 'tracker', config: TRACKER }] });
    expect(await backend.pendingProjectServer('tracker')).toBeUndefined();
    expect(fs.existsSync(place.projectFile)).toBe(false);
  });

  it('writes the user settings with no question in a folder that is not trusted', async () => {
    const place = freshPlace();
    const { context, recorded } = contextOf({}, { settingsPlace: { home: place.home, projectDir: place.project }, mcpServers: SERVERS, trust: { path: place.project, decision: 'untrusted' } }, { choices: [{ index: ADD_HTTP_INDEX, alt: false }], texts: ['tracker', TRACKER.url] });
    await runSlash('mcp', '', context);
    expect(recorded.picks.map((pick) => pick.title)).not.toContain(SAVE_TO_TITLE);
    expect(stored(place.userFile)).toEqual({ mcpServers: { tracker: TRACKER } });
    expect(fs.existsSync(path.join(place.project, '.mcp.json'))).toBe(false);
  });
});
