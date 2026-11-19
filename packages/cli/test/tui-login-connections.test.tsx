import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, choose, startPlan, submitLine, untilRow } from './fake-plan-gateway.tsx';
import { untilFrame } from './ink-helpers.ts';
import { freshPlace } from './tui/settings-harness.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const LOCAL = 'ollama/qwen3.8:27b';
const ADDRESS = 'http://127.0.0.1:11434';

const placeWithOllama = () => {
  const place = freshPlace();
  fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(place.userFile, JSON.stringify({ models: { connections: [{ adapter: 'ollama', baseUrl: ADDRESS, models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } }), { mode: 0o600 });
  return place;
};

const connectionsIn = (file: string): unknown[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { connections: unknown[] } }).models.connections;

describe('a connection of /login opens the actions of its server', () => {
  it('a local server row offers editing, naming and removing the server', async () => {
    const place = placeWithOllama();
    const { app } = await startPlan({ session: { model: LOCAL }, models: [LOCAL], billing: { [LOCAL]: 'local' }, accounts: [], settingsPlace: { home: place.home, projectDir: place.project } });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    await choose(app, `${LOCAL} [local server]`);
    const menu = await untilRow(app, 'Remove server');
    expect(menu).toContain('Edit server');
    expect(menu).toContain('Name this server');
    app.unmount();
  });

  it('removing the server from its row asks first, and writes nothing when the answer is no', async () => {
    const place = placeWithOllama();
    const { app } = await startPlan({ session: { model: LOCAL }, models: [LOCAL], billing: { [LOCAL]: 'local' }, accounts: [], settingsPlace: { home: place.home, projectDir: place.project } });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    await choose(app, `${LOCAL} [local server]`);
    await choose(app, 'Remove server');
    await untilFrame(app, 'Remove ollama and its model?');
    await choose(app, 'No');
    expect(connectionsIn(place.userFile)).toHaveLength(1);
    app.unmount();
  });

  it('removing the server from its row after the confirm removes its connection', async () => {
    const place = placeWithOllama();
    const { app } = await startPlan({ session: { model: LOCAL }, models: [LOCAL], billing: { [LOCAL]: 'local' }, accounts: [], settingsPlace: { home: place.home, projectDir: place.project } });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    await choose(app, `${LOCAL} [local server]`);
    await choose(app, 'Remove server');
    await untilFrame(app, 'Remove ollama and its model?');
    await choose(app, 'Yes');
    await untilFrame(app, 'Removed');
    expect(connectionsIn(place.userFile)).toEqual([]);
    app.unmount();
  });
});
