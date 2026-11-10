import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { addModelConnection } from '@momonga/config';
import { systemFileLockPorts, withFileLock } from '@momonga/foundation';
import { settingsLockPath } from '../src/file-lock.ts';
import type { ModelConnection } from '@momonga/config';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const settingsFileIn = (contents?: unknown): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-connect-')));
  homes.push(home);
  const file = path.join(home, '.momonga', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
};

type Written = { models: { targets: Record<string, Record<string, unknown>>; aliases: Record<string, string | string[]> } };

const homeOf = (file: string): string => path.dirname(path.dirname(file));

const read = (file: string): Written => JSON.parse(fs.readFileSync(file, 'utf8')) as Written;

const targetsOf = (alias: string | string[] | undefined): string[] => (alias === undefined ? [] : [alias].flat());

const ollama = (model: string, contextWindow: number): ModelConnection => ({ kind: 'server', baseUrl: 'http://127.0.0.1:11434', shape: 'ollama', model, contextWindow });

describe('addModelConnection, the one writer of a chosen local model', () => {
  it('writes an Ollama-shape server as adapter ollama, billing local, one at a time, with the entered window and its derived output bound', async () => {
    const file = settingsFileIn();
    const written = await addModelConnection(homeOf(file), file, ollama('qwen2.5-coder:1.5b', 8192));
    expect(written).toEqual({ target: 'qwen2.5-coder-1.5b', alias: 'qwen2.5-coder-1.5b' });
    const target = read(file).models.targets['qwen2.5-coder-1.5b'];
    expect(target?.['adapter']).toBe('ollama');
    expect(target?.['model']).toBe('qwen2.5-coder:1.5b');
    expect(target?.['baseUrl']).toBe('http://127.0.0.1:11434');
    expect(target?.['billing']).toBe('local');
    expect(target?.['maxConcurrency']).toBe(1);
    expect(target?.['capabilities']).toMatchObject({ contextWindow: 8192, maxOutputTokens: 2048 });
    expect(target).not.toHaveProperty('toolCalling');
    expect(targetsOf(read(file).models.aliases['qwen2.5-coder-1.5b'])).toEqual(['qwen2.5-coder-1.5b']);
  });

  it('writes an OpenAI-shape server as adapter chat-completions with provider local-<port>', async () => {
    const file = settingsFileIn();
    await addModelConnection(homeOf(file), file, { kind: 'server', baseUrl: 'http://127.0.0.1:1234', shape: 'openai', model: 'qwen2.5-coder-1.5b-instruct-mlx', contextWindow: 32768 });
    const target = read(file).models.targets['qwen2.5-coder-1.5b-instruct-mlx'];
    expect(target?.['adapter']).toBe('chat-completions');
    expect(target?.['provider']).toBe('local-1234');
    expect(target?.['billing']).toBe('local');
    expect(target?.['maxConcurrency']).toBe(1);
    expect(target?.['capabilities']).toMatchObject({ contextWindow: 32768, maxOutputTokens: 8192 });
  });

  it('writes a managed-server description as exactly adapter managed, its server id and maxConcurrency 1, with no model and never adapter fm', async () => {
    const file = settingsFileIn();
    const written = await addModelConnection(homeOf(file), file, { kind: 'managed', server: 'fm' });
    const target = read(file).models.targets[written.target];
    expect(target).toEqual({ adapter: 'managed', server: 'fm', maxConcurrency: 1 });
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/"adapter"\s*:\s*"fm"/);
  });

  it('refuses an Ollama-shape model without an entered context window and writes nothing', async () => {
    const file = settingsFileIn();
    const withoutWindow = { kind: 'server', baseUrl: 'http://127.0.0.1:11434', shape: 'ollama', model: 'llama3.2' } as unknown as ModelConnection;
    await expect(addModelConnection(homeOf(file), file, withoutWindow)).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('names the target from the model id: each run outside [A-Za-z0-9._-] becomes one dash, and a name not starting with a letter gets model-', async () => {
    const file = settingsFileIn();
    expect((await addModelConnection(homeOf(file), file, ollama('7b/llama', 4096))).target).toBe('model-7b-llama');
    expect((await addModelConnection(homeOf(file), file, ollama('a:: b', 4096))).target).toBe('a-b');
  });

  it('gives a taken name -2, then -3', async () => {
    const file = settingsFileIn({ models: { targets: { 'llama3.2-latest': { adapter: 'ollama', model: 'other', capabilities: { contextWindow: 10, maxOutputTokens: 5 } } }, aliases: { default: 'llama3.2-latest' } } });
    expect((await addModelConnection(homeOf(file), file, ollama('llama3.2:latest', 4096))).target).toBe('llama3.2-latest-2');
    expect((await addModelConnection(homeOf(file), file, ollama('llama3.2:latest', 4096))).target).toBe('llama3.2-latest-3');
  });

  it('writes aliases.default too only when models.targets was empty', async () => {
    const empty = settingsFileIn();
    await addModelConnection(homeOf(empty), empty, ollama('first', 4096));
    expect(targetsOf(read(empty).models.aliases['default'])).toEqual(['first']);

    const existing = settingsFileIn({ models: { targets: { keep: { adapter: 'ollama', model: 'keep', capabilities: { contextWindow: 10, maxOutputTokens: 5 } } }, aliases: { default: 'keep' } } });
    await addModelConnection(homeOf(existing), existing, ollama('second', 4096));
    expect(targetsOf(read(existing).models.aliases['default'])).toEqual(['keep']);
    expect(read(existing).models.targets['keep']).toEqual({ adapter: 'ollama', model: 'keep', capabilities: { contextWindow: 10, maxOutputTokens: 5 } });
  });
  it('writes the local-server value on each of billing, maxConcurrency and provider that the shape schema declares, and nothing else of them', async () => {
    const file = settingsFileIn();
    const ollamaTarget = (await addModelConnection(homeOf(file), file, ollama('o-model', 4096))).target;
    const openaiTarget = (await addModelConnection(homeOf(file), file, { kind: 'server', baseUrl: 'http://127.0.0.1:1234', shape: 'openai', model: 'c-model', contextWindow: 4096 })).target;
    const managedTarget = (await addModelConnection(homeOf(file), file, { kind: 'managed', server: 'fm' })).target;
    const pick = (target: Record<string, unknown> | undefined) => ({ billing: target?.['billing'], maxConcurrency: target?.['maxConcurrency'], provider: target?.['provider'] });
    const targets = read(file).models.targets;
    expect(pick(targets[ollamaTarget])).toEqual({ billing: 'local', maxConcurrency: 1, provider: undefined });
    expect(pick(targets[openaiTarget])).toEqual({ billing: 'local', maxConcurrency: 1, provider: 'local-1234' });
    expect(pick(targets[managedTarget])).toEqual({ billing: undefined, maxConcurrency: 1, provider: undefined });
  });
});

type EditUserSettings = (home: string, settingsFile: string, edit: (document: Record<string, unknown>) => boolean) => Promise<unknown>;

const editUserSettings: EditUserSettings = (home, settingsFile, edit) => {
  const value = (config as Record<string, unknown>)['editUserSettings'];
  if (typeof value !== 'function') throw new Error('@momonga/config does not export editUserSettings (design-chatgpt-plan O-R5-6 L10, build step 3)');
  return (value as EditUserSettings)(home, settingsFile, edit);
};

describe('O-R5-6 L10: editUserSettings, the writer addModelConnection shares', () => {
  it('editUserSettings keeps every other key, writes under the settings lock with mode 0600, skips the write when edit returns false', async () => {
    const file = settingsFileIn({ network: { httpsProxy: 'http://proxy.corp:3128' }, models: { aliases: { a: ['a'] }, targets: { a: { adapter: 'ollama', model: 'm' } } } });
    fs.chmodSync(file, 0o644);
    let lockHeld = true;
    let editedWhileLocked = false;
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    fs.mkdirSync(path.dirname(settingsLockPath(homeOf(file), file)), { recursive: true, mode: 0o700 });
    const holder = withFileLock(settingsLockPath(homeOf(file), file), () => released, { ports: systemFileLockPorts });
    const edited = editUserSettings(homeOf(file), file, (document) => {
      editedWhileLocked = lockHeld;
      (document['models'] as { aliases: Record<string, string[]> }).aliases['b'] = ['a'];
      return true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    lockHeld = false;
    release();
    await holder;
    await edited;
    expect(editedWhileLocked).toBe(false);
    expect(read(file)).toEqual({ network: { httpsProxy: 'http://proxy.corp:3128' }, models: { aliases: { a: ['a'], b: ['a'] }, targets: { a: { adapter: 'ollama', model: 'm' } } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const compact = '{"models":{"aliases":{},"targets":{}}}';
    fs.writeFileSync(file, compact, { mode: 0o600 });
    let called = 0;
    await editUserSettings(homeOf(file), file, (document) => {
      called += 1;
      document['network'] = { httpsProxy: 'http://ignored:1' };
      return false;
    });
    expect(called).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(compact);
  });
});
