import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import * as protocol from '@momonga/protocol';
import { FAKE_SERVER } from '@momonga/testkit';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const fmServer = (): unknown => {
  const value = (protocol as Record<string, unknown>)['FM_SERVER'];
  if (value === undefined) throw new Error('@momonga/protocol does not export FM_SERVER');
  return value;
};

const makeHome = (): string => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mm-managed-'));
  fs.mkdirSync(path.join(home, '.momonga'), { recursive: true, mode: 0o700 });
  homes.push(home);
  return home;
};

const settingsFile = (home: string): string => path.join(home, '.momonga', 'settings.json');

const writeTarget = (home: string, target: Record<string, unknown>): void => {
  fs.writeFileSync(settingsFile(home), JSON.stringify({ models: { targets: { apple: target }, aliases: { default: 'apple' } } }), { mode: 0o600 });
};

type LoadOptions = Parameters<typeof loadUserSettings>[0];

const load = async (target: Record<string, unknown>, managedServers?: readonly unknown[]) => {
  const home = makeHome();
  writeTarget(home, target);
  return loadUserSettings((managedServers === undefined ? { home } : { home, managedServers }) as LoadOptions);
};

const messageOf = async (loading: Promise<unknown>): Promise<string> => {
  const outcome = await loading.then(
    () => undefined,
    (error: unknown) => (error as Error).message,
  );
  if (outcome === undefined) throw new Error('the settings loaded, but the test expects them to be refused');
  return outcome;
};

describe('a target served by a managed server (design-managed-servers section 3.1, decision 70)', () => {
  it('loads adapter "managed" with server "fm" and fills binary and readyTimeoutMs from the fm description', async () => {
    const { settings } = await load({ adapter: 'managed', server: 'fm' });
    expect(settings.models.targets['apple']).toMatchObject({
      adapter: 'managed',
      server: 'fm',
      binary: '/usr/bin/fm',
      readyTimeoutMs: 10_000,
      toolCalling: 'auto',
      billing: 'local',
      maxConcurrency: 1,
      admissionTimeoutMs: 30_000,
    });
    expect(settings.models.targets['apple']).not.toHaveProperty('model');
  });

  it('keeps a declared binary, model, readyTimeoutMs and declared capabilities', async () => {
    const { settings } = await load({ adapter: 'managed', server: 'fm', binary: '/opt/fm/bin/fm', model: 'system', readyTimeoutMs: 45_000, capabilities: { contextWindow: 4096, maxOutputTokens: 512 } });
    expect(settings.models.targets['apple']).toMatchObject({ binary: '/opt/fm/bin/fm', model: 'system', readyTimeoutMs: 45_000, capabilities: { contextWindow: 4096, maxOutputTokens: 512 } });
  });

  it.each([0, 300_001])('refuses readyTimeoutMs %d, outside 1 to 300000', async (readyTimeoutMs) => {
    expect(await messageOf(load({ adapter: 'managed', server: 'fm', readyTimeoutMs }))).toMatch(/readyTimeoutMs/);
  });

  it('refuses a managed target that names no server', async () => {
    expect(await messageOf(load({ adapter: 'managed' }))).toMatch(/server/);
  });

  it('refuses a server id no description declares, with the English text that lists the supported ids', async () => {
    expect(await messageOf(load({ adapter: 'managed', server: 'llama' }))).toContain('models.targets.apple: server "llama" is not a managed server this build supports; supported: fm');
  });

  it.each([
    ['jsonMode', { jsonMode: 'json_object' }],
    ['schemaDialect', { schemaDialect: 'json-schema' }],
  ])('refuses %s on a managed target, because the fm description does not declare it', async (field, extra) => {
    expect(await messageOf(load({ adapter: 'managed', server: 'fm', ...extra }))).toContain(field);
  });

  it('refuses the old adapter "fm" by the one rule that refuses any undeclared adapter, with the same text as adapter "typo"', async () => {
    const home = makeHome();
    writeTarget(home, { adapter: 'fm' });
    const old = await messageOf(loadUserSettings({ home }));
    writeTarget(home, { adapter: 'typo' });
    const typo = await messageOf(loadUserSettings({ home }));
    expect(old).toBe(`${settingsFile(home)}: invalid settings at /models/targets/apple/adapter: must be equal to one of the allowed values`);
    expect(old).toBe(typo);
  });
});

describe('the registration entry point: the list of descriptions the loader validates against (design section 3.1, test injection)', () => {
  it('loads a target of a second kind when its description is registered, with that description defaults', async () => {
    const { settings } = await load({ adapter: 'managed', server: 'fake' }, [fmServer(), FAKE_SERVER]);
    expect(settings.models.targets['apple']).toMatchObject({ adapter: 'managed', server: 'fake', binary: '/nonexistent/fake-server', readyTimeoutMs: 25_000 });
  });

  it('refuses the second kind when only the built-in list is registered', async () => {
    expect(await messageOf(load({ adapter: 'managed', server: 'fake' }, [fmServer()]))).toContain('models.targets.apple: server "fake" is not a managed server this build supports; supported: fm');
  });

  it('lists every registered id in the refusal of an unknown id', async () => {
    expect(await messageOf(load({ adapter: 'managed', server: 'llama' }, [fmServer(), FAKE_SERVER]))).toContain('models.targets.apple: server "llama" is not a managed server this build supports; supported: fm, fake');
  });
});
