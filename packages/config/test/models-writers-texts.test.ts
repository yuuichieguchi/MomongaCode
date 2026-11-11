import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { SERVER_KINDS } from '@momonga/protocol';
import { assertSettings } from '../src/settings.ts';
import { S1_FILE } from './model-fixtures.ts';
import { editModels, homeWith, op, planModels, refusalOfEdit } from './models-edit.ts';

const exported = <T>(name: string): T => {
  const value = (config as Record<string, unknown>)[name];
  if (typeof value !== 'function') throw new Error(`@momonga/config does not export ${name} (packages/config/src/models-writers.ts)`);
  return value as T;
};

const serverNameFromCommand = (command: string, taken: readonly string[] = [], platform: NodeJS.Platform = 'darwin'): string | undefined =>
  exported<(command: string, taken: ReadonlySet<string>, platform: NodeJS.Platform) => string | undefined>('serverNameFromCommand')(command, new Set(taken), platform);

const fieldValueText = (field: string, value: unknown): string => exported<(field: string, value: unknown) => string>('fieldValueText')(field, value);

describe('serverNameFromCommand: the name offered for a program that is run as a model server', () => {
  it('is the file name of the command', () => {
    expect(serverNameFromCommand('/opt/homebrew/bin/llama-server')).toBe('llama-server');
  });

  it('on Windows: the last segment by the Windows rule, without its extension, lower-cased, other characters as dashes', () => {
    expect(serverNameFromCommand('C:\\tools\\Llama Server.exe', [], 'win32')).toBe('llama-server');
  });

  it('a taken name gets -2', () => {
    expect(serverNameFromCommand('/opt/homebrew/bin/llama-server', ['llama-server'])).toBe('llama-server-2');
  });

  it('then -3', () => {
    expect(serverNameFromCommand('/opt/homebrew/bin/llama-server', ['llama-server', 'llama-server-2'])).toBe('llama-server-3');
  });

  it('leading characters a name cannot start with are removed', () => {
    expect(serverNameFromCommand('/opt/bin/9lives')).toBe('lives');
  });

  it('a file name with no letter gives no name', () => {
    expect(serverNameFromCommand('/opt/bin/___')).toBeUndefined();
  });
});

describe('fieldValueText: the one text of a setting value, in the row and in the summary', () => {
  it('an integer as plain digits', () => {
    expect(fieldValueText('models[].capabilities.contextWindow', 32768)).toBe('32768');
  });

  it('a boolean as yes or no', () => {
    expect(fieldValueText('models[].capabilities.streaming', true)).toBe('yes');
    expect(fieldValueText('models[].capabilities.streaming', false)).toBe('no');
  });

  it('an enum as the label its row shows', () => {
    expect(fieldValueText('adapter', 'ollama')).toBe('Ollama API');
    expect(fieldValueText('answers', 'model')).toBe('A model');
  });

  it('an enum whose rows show the stored word shows that word', () => {
    expect(fieldValueText('billing', 'local')).toBe('local');
  });

  it('a list joined with a comma and a space', () => {
    expect(fieldValueText('models[].capabilities.allowedTools', ['native', 'envelope'])).toBe('native, envelope');
  });

  it('a value that is not written: not declared for a toggle, not set for every other kind', () => {
    expect(fieldValueText('models[].capabilities.imageInput', undefined)).toBe('not declared');
    expect(fieldValueText('models[].capabilities.contextWindow', undefined)).toBe('not set');
    expect(fieldValueText('billing', undefined)).toBe('not set');
  });

  it('a duration by the rule of the wait limits, and the summary of a changed field uses the same text', async () => {
    expect(fieldValueText('readyTimeoutMs', 0)).toBe('never cut');
    expect(fieldValueText('readyTimeoutMs', 300000)).toBe('5 min');
    expect(fieldValueText('admissionTimeoutMs', 90000)).toBe('90 s');
    expect(fieldValueText('admissionTimeoutMs', 1500)).toBe('1500 ms');
    const home = homeWith(S1_FILE);
    const result = await editModels(home, [op('setModelField', { model: 'ollama/devstral-small-2:latest', path: ['capabilities', 'contextWindow'], value: 32768 })]);
    expect(result.summaries).toEqual(['Set Context window of devstral-small-2 to 32768.']);
  });
});

describe('a writer turns only a load error into a refusal; any other error leaves the writer as it is', () => {
  const WINDOW = { contextWindow: 4096, maxOutputTokens: 1024 };
  const addModel = (connection: Record<string, unknown>) => op('addModel', { choice: { connection, model: { id: 'm', capabilities: WINDOW } } });
  const brokenKinds = [
    {
      ...SERVER_KINDS[0],
      get impliedByAdapter(): string {
        throw new TypeError('the kind table is broken');
      },
    },
  ];
  const planWith = (kinds: unknown, document: unknown, operations: readonly unknown[]): unknown =>
    exported<(document: unknown, operations: readonly unknown[], ports: unknown) => unknown>('planModelsEdit')(document, operations, { kinds });

  it('a TypeError raised while a server name is derived is thrown by the plan and is not shown as Not saved', () => {
    expect(() => planWith(brokenKinds, S1_FILE, [op('setStart', { model: null })])).toThrow(new TypeError('the kind table is broken'));
    expect(() => planWith(brokenKinds, {}, [addModel({ adapter: 'chat-completions', provider: 'mine', baseUrl: 'http://127.0.0.1:8080/v1' })])).toThrow(TypeError);
  });

  it('a connection without an address is refused by the load of the result, with or without a written name', async () => {
    for (const connection of [{ adapter: 'chat-completions' }, { adapter: 'chat-completions', provider: 'mine' }]) {
      const home = homeWith();
      const refused = await refusalOfEdit(editModels(home, [addModel(connection)]));
      expect(refused.code).toBe('invalid_value');
      expect(refused.message).toContain('models/connections/0');
    }
  });

  it('an address that is no URL is refused by the load of the result and does not end the writer', async () => {
    const refused = await refusalOfEdit(editModels(homeWith(), [addModel({ adapter: 'chat-completions', provider: 'mine', baseUrl: 'not a url' })]));
    expect(refused.code).toBe('would_not_load');
    expect(refused.message.startsWith('Not saved: ')).toBe(true);
  });

  it('the errors of the loader the writer turns into refusals are ConfigError', () => {
    const ConfigError = (config as unknown as { ConfigError: new (...args: never[]) => Error }).ConfigError;
    const caught = (work: () => unknown): unknown => {
      try {
        work();
      } catch (error) {
        return error;
      }
      throw new Error('nothing was thrown');
    };
    expect(caught(() => assertSettings({ tui: { theme: 'bogus' } }, 'settings'))).toBeInstanceOf(ConfigError);
    expect(caught(() => assertSettings({ models: { connections: [{ adapter: 'chat-completions', models: [{ id: 'm' }] }] } }, 'settings'))).toBeInstanceOf(ConfigError);
    expect(planModels({ models: { start: 'nowhere/none' } }, [op('setTimeouts', { idleTimeoutMs: 1000 })])).toEqual({
      refused: { code: 'would_not_load', message: 'Not saved: models.start: "nowhere/none" is not a configured model; no model is configured' },
    });
  });
});
