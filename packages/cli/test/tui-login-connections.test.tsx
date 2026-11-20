import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, account, choose, eventually, startPlan, submitLine, untilRow } from './fake-plan-gateway.tsx';
import { KEYS } from './ink-helpers.ts';
import { untilFrame } from './ink-helpers.ts';
import { freshPlace } from './tui/settings-harness.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const LOCAL = 'ollama/qwen3.8:27b';
const KEYED = 'openai/gpt-5.5';
const LOCAL_KEYED = 'lmstudio/m';

const placeWith = () => {
  const place = freshPlace();
  fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
  const connections = [
    { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
    { adapter: 'chat-completions', provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKeyEnv: 'LMSTUDIO_KEY', models: [{ id: 'm', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
    { adapter: 'open-responses', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'gpt-5.5', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] },
  ];
  fs.writeFileSync(place.userFile, JSON.stringify({ models: { connections } }), { mode: 0o600 });
  return place;
};

const connectionsIn = (file: string): { provider?: string }[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { connections: { provider?: string }[] } }).models.connections;

const openLogin = async () => {
  const place = placeWith();
  const started = await startPlan({ session: { model: LOCAL }, models: [LOCAL, LOCAL_KEYED, KEYED], billing: { [LOCAL]: 'local' }, keyGroups: { [KEYED]: 'openai', [LOCAL_KEYED]: 'lmstudio' }, accounts: [], settingsPlace: { home: place.home, projectDir: place.project } });
  await untilFrame(started.app, 'mode: manual');
  await submitLine(started.app, '/login');
  return { ...started, place };
};

describe('/login holds what needs a sign-in or a key', () => {
  it('lists one row per API-key provider outside the person own network and no local server, keyed or not', async () => {
    const { app } = await openLogin();
    const listed = await untilRow(app, 'openai [API key] · configured');
    expect(listed).not.toContain('local server');
    expect(listed).not.toContain('lmstudio');
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
    expect(connectionsIn(place.userFile).map((connection) => connection.provider)).toEqual([undefined, 'lmstudio']);
    app.unmount();
  });
});

const PLAN_MODEL = 'work/gpt-6-luna';

const openAccounts = async () => {
  const place = freshPlace();
  fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(place.userFile, JSON.stringify({ models: { connections: [{ adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'work' }, models: [{ id: 'gpt-6-luna', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } }), { mode: 0o600 });
  const started = await startPlan({ session: { model: PLAN_MODEL }, models: [PLAN_MODEL], planTargets: { [PLAN_MODEL]: { profile: 'chatgpt', account: 'work' } }, accounts: [account({ label: 'work', pinnedBy: [PLAN_MODEL] })], settingsPlace: { home: place.home, projectDir: place.project } });
  await untilFrame(started.app, 'mode: manual');
  await submitLine(started.app, '/login');
  await choose(started.app, '[subscription]');
  return { ...started, place };
};

describe('the account picker renames and removes every account', () => {
  it('shows a rename and a remove row for the account', async () => {
    const { app } = await openAccounts();
    const picker = await untilRow(app, 'Remove account work');
    expect(picker).toContain('Rename account work');
    expect(picker).not.toContain('Name this server');
    app.unmount();
  });

  it('rename changes the label of the account and points its connection to the new label', async () => {
    const { app, place } = await openAccounts();
    await choose(app, 'Rename account work');
    await untilFrame(app, 'enter to confirm');
    app.stdin.write('\u007f'.repeat(4));
    app.stdin.write('job');
    app.stdin.write(KEYS.enter);
    await eventually(() => connectionsWithAccount(place.userFile).includes('job'), 'the connection points to the new label');
    app.unmount();
  });

  it('when the connection cannot be pointed to the new label, the account is renamed back and the connection keeps its label', async () => {
    const { app, place, backend } = await openAccounts();
    fs.chmodSync(path.dirname(place.userFile), 0o500);
    await choose(app, 'Rename account work');
    await untilFrame(app, 'enter to confirm');
    app.stdin.write('\u007f'.repeat(4));
    app.stdin.write('job');
    app.stdin.write(KEYS.enter);
    await eventually(() => backend.planCalls.filter((call) => call.route === 'accounts/rename').length === 2, 'the account is renamed back');
    expect(backend.planCalls.filter((call) => call.route === 'accounts/rename').at(-1)).toEqual({ route: 'accounts/rename', body: { profile: 'chatgpt', account: 'job', to: 'work' } });
    expect(connectionsWithAccount(place.userFile)).toEqual(['work']);
    fs.chmodSync(path.dirname(place.userFile), 0o700);
    app.unmount();
  });

  it('remove signs the account out after one confirm and removes the connection that it serves', async () => {
    const { app, place } = await openAccounts();
    await choose(app, 'Remove account work');
    await untilFrame(app, (shown) => shown.includes('› 1. Remove account work') && !shown.includes('Rename account work'));
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'again to sign out work');
    app.stdin.write(KEYS.enter);
    await eventually(() => connectionsIn(place.userFile).length === 0, 'the connection is removed');
    app.unmount();
  });
});

const connectionsWithAccount = (file: string): string[] =>
  (JSON.parse(fs.readFileSync(file, 'utf8')) as { models: { connections: { plan?: { account?: string } }[] } }).models.connections.flatMap((connection) =>
    connection.plan?.account === undefined ? [] : [connection.plan.account],
  );

const openProfileOnly = async (accounts: ReturnType<typeof account>[]) => {
  const place = freshPlace();
  fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(place.userFile, JSON.stringify({ models: { connections: [{ adapter: 'open-responses', plan: { profile: 'chatgpt' }, models: [{ id: 'gpt-6-luna', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } }), { mode: 0o600 });
  const started = await startPlan({ session: { model: PROFILE_MODEL }, models: [PROFILE_MODEL], planTargets: { [PROFILE_MODEL]: { profile: 'chatgpt' } }, accounts, settingsPlace: { home: place.home, projectDir: place.project } });
  await untilFrame(started.app, 'mode: manual');
  return { ...started, place };
};

const PROFILE_MODEL = 'chatgpt/gpt-6-luna';

describe('a connection pinned only to its profile belongs to the active account of the profile', () => {
  it('the active account carries its rename and remove rows, and remove removes it', async () => {
    const { app, place } = await openProfileOnly([account({ label: 'work', pinnedBy: [PROFILE_MODEL] })]);
    await submitLine(app, '/login');
    await choose(app, '[subscription]');
    const picker = await untilRow(app, 'Remove account work');
    expect(picker).toContain('Rename account work');
    await choose(app, 'Remove account work');
    await untilFrame(app, (shown) => shown.includes('› 1. Remove account work') && !shown.includes('Rename account work'));
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'again to sign out work');
    app.stdin.write(KEYS.enter);
    await eventually(() => connectionsIn(place.userFile).length === 0, 'the connection is removed');
    app.unmount();
  });

  it('every saved account carries the rename and remove rows, also one with no connection', async () => {
    const { app } = await openProfileOnly([account({ label: 'work', pinnedBy: [PROFILE_MODEL] }), account({ label: 'home', active: false, pinnedBy: [] })]);
    await submitLine(app, '/login');
    await choose(app, '[subscription]');
    const picker = await untilRow(app, 'Remove account home');
    expect(picker).toContain('Rename account home');
    app.unmount();
  });

  it('with no active account the connection keeps its row in the Servers group of the model settings', async () => {
    const { app } = await openProfileOnly([account({ label: 'work', active: false, state: 'needs_sign_in', pinnedBy: [] })]);
    await submitLine(app, '/model');
    await choose(app, 'Model settings…');
    const screen = await untilRow(app, 'Check the servers');
    expect(screen).toContain('Servers');
    expect(screen).toMatch(/\d+\. chatgpt\s/);
    app.unmount();
  });
});
