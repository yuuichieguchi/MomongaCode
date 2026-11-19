import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, choose, startPlan, submitLine, untilRow } from './fake-plan-gateway.tsx';
import { untilFrame } from './ink-helpers.ts';
import { freshPlace } from './tui/settings-harness.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const LOCAL = 'ollama/qwen3.8:27b';
const KEYED = 'openai/gpt-5.5';

const placeWith = () => {
  const place = freshPlace();
  fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
  const connections = [
    { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
    { adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.5', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
  ];
  fs.writeFileSync(place.userFile, JSON.stringify({ models: { connections } }), { mode: 0o600 });
  return place;
};

const connectionsIn = (file: string): { provider?: string }[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { connections: { provider?: string }[] } }).models.connections;

const openLogin = async () => {
  const place = placeWith();
  const started = await startPlan({ session: { model: LOCAL }, models: [LOCAL, KEYED], billing: { [LOCAL]: 'local' }, keyGroups: { [KEYED]: 'openai' }, accounts: [], settingsPlace: { home: place.home, projectDir: place.project } });
  await untilFrame(started.app, 'mode: manual');
  await submitLine(started.app, '/login');
  return { ...started, place };
};

describe('/login holds what needs a sign-in or a key', () => {
  it('lists one row per API-key provider and no local server', async () => {
    const { app } = await openLogin();
    const listed = await untilRow(app, 'openai [API key] · configured');
    expect(listed).not.toContain('local server');
    expect(listed).not.toContain(LOCAL);
    app.unmount();
  });

  it('an API-key provider row offers editing, naming and removing it', async () => {
    const { app } = await openLogin();
    await choose(app, 'openai [API key]');
    const menu = await untilRow(app, 'Remove server');
    expect(menu).toContain('Edit server');
    expect(menu).toContain('Name this server');
    app.unmount();
  });

  it('removing it asks first and removes only its connection after the confirm', async () => {
    const { app, place } = await openLogin();
    await choose(app, 'openai [API key]');
    await choose(app, 'Remove server');
    await untilFrame(app, 'Remove openai and its model?');
    await choose(app, 'Yes');
    await untilFrame(app, 'Removed');
    expect(connectionsIn(place.userFile).map((connection) => connection.provider)).toEqual([undefined]);
    app.unmount();
  });
});
