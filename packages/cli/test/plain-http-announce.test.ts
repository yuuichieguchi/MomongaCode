import { describe, expect, it } from 'vitest';
import { listModels, runModelsForm } from '../src/commands/models.ts';
import { announcePlainHttp, shellModelsOf } from '../src/plain-http.ts';
import { homeWith, shellOf } from './models-shell-harness.ts';

const TEXT = 'momonga: The address of gpu-box is plain http to another computer: what you send to it is not encrypted.\n';

const PLAIN = {
  models: { connections: [{ adapter: 'chat-completions', provider: 'gpu-box', baseUrl: 'http://192.168.1.20:8080/v1', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }] },
};

const LOCAL = {
  models: { connections: [{ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'm', capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }] }] },
};

describe('plain http to another computer, in the shell commands and headless', () => {
  it('prints the sentence once on stderr for a server, however often it is announced', () => {
    const written: string[] = [];
    const ports = { home: '/homes/once', stderr: { write: (text: string) => void written.push(text) } };
    announcePlainHttp(ports, ['gpu-box']);
    announcePlainHttp(ports, ['gpu-box']);
    expect(written).toEqual([TEXT]);
  });

  it('is printed when a shell command loads the settings, once over two commands, and never on stdout', async (context) => {
    const harness = shellOf(homeWith(context, PLAIN));
    expect(await listModels(harness.shell, { json: false })).toBe(0);
    expect(await runModelsForm(harness.shell, 'fallback list', { args: [], options: {} })).toBe(0);
    expect(harness.err()).toBe(TEXT);
    expect(harness.out()).not.toContain('plain http');
  });

  it('is printed by the load of headless and of the other shell commands', (context) => {
    const { home } = homeWith(context, PLAIN);
    const written: string[] = [];
    const models = shellModelsOf({ home, stderr: { write: (text) => void written.push(text) } });
    expect([...models.resolved.models.keys()]).toEqual(['gpu-box/m']);
    expect(written).toEqual([TEXT]);
  });

  it('prints nothing for a server on this computer', async (context) => {
    const harness = shellOf(homeWith(context, LOCAL));
    expect(await listModels(harness.shell, { json: false })).toBe(0);
    expect(harness.err()).toBe('');
  });
});
