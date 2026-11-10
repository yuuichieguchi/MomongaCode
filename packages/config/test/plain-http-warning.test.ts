import { describe, expect, it } from 'vitest';
import * as config from '@momonga/config';
import { chatConnection, ollamaConnection } from './model-fixtures.ts';
import { loadFile, sentenceOf } from './load-models.ts';

const textOf = (server: string): string => `The address of ${server} is plain http to another computer: what you send to it is not encrypted.`;

const plainHttpOf = (models: unknown): readonly string[] => (models as { plainHttp: readonly string[] }).plainHttp;

describe('plain http to another computer', () => {
  it('has one sentence, built by one function of the config package', () => {
    const build = (config as unknown as { plainHttpWarningText(server: string): string }).plainHttpWarningText;
    expect(build('gpu-box')).toBe(textOf('gpu-box'));
  });

  it('accepts a connection without a credential and warns once per server when the settings are loaded', async () => {
    const loaded = await loadFile({ models: { connections: [chatConnection('http://192.168.1.20:8080/v1', ['m', 'n'], { provider: 'gpu-box' })] } });
    expect([...loaded.models.models.keys()]).toEqual(['gpu-box/m', 'gpu-box/n']);
    expect(loaded.warnings).toEqual([textOf('gpu-box')]);
    expect(plainHttpOf(loaded.models)).toEqual(['gpu-box']);
  });

  it('names the server by the name the loader derives when none is written', async () => {
    const loaded = await loadFile({ models: { connections: [ollamaConnection('http://192.168.1.20:11434')] } });
    const [provider] = loaded.models.views.map((view) => view.provider);
    expect(loaded.warnings).toEqual([textOf(String(provider))]);
    expect(plainHttpOf(loaded.models)).toEqual([provider]);
  });

  it('does not warn for http to this computer or for https to another one', async () => {
    const loaded = await loadFile({ models: { connections: [ollamaConnection('http://127.0.0.1:11434'), chatConnection('https://models.example/v1', ['m'], { provider: 'far' })] } });
    expect(loaded.warnings).toEqual([]);
    expect(plainHttpOf(loaded.models)).toEqual([]);
  });

  it('still refuses a connection that carries a credential', async () => {
    const sentence = await sentenceOf({ models: { connections: [chatConnection('http://192.168.1.20:8080/v1', ['m'], { provider: 'gpu-box', apiKeyEnv: 'GPU_BOX_KEY' })] } });
    expect(sentence).toContain('must use https: because this connection sends a credential');
  });
});
