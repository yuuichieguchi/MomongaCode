import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserModels } from '@momonga/config';
import { momongaLayout, pipePathFor } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { cliProbeInstance, probeModel, probeSubjectOf } from '../src/commands/gateway.ts';
import type { CliPorts } from '../src/ports.ts';
import { S3, homeWith, threeModels } from './models-shell-harness.ts';

describe('momonga gateway probe <model>', () => {
  it('resolves what a person types by the typed rule, the display name included', async (context) => {
    const { resolved } = await loadUserModels({ home: homeWith(context, threeModels()).home, signal: new AbortController().signal });

    expect(probeSubjectOf(resolved, 'ollama/gemma-3-4b')).toMatchObject({ canon: 'ollama/gemma-3-4b:latest', display: 'ollama/gemma-3-4b' });
    expect(probeSubjectOf(resolved, 'qwen3.8:27b')).toMatchObject({ canon: 'ollama/qwen3.8:27b', display: 'ollama/qwen3.8:27b' });
    expect(() => probeSubjectOf(resolved, 'gemma-3-4b')).toThrow('The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.');
  });

  it('refuses a model that cannot be probed with the sentence that names it and the configured models', async (context) => {
    const at = homeWith(context, S3);
    const ports = { home: at.home } as unknown as CliPorts;

    await expect(probeModel(ports, momongaLayout(at.home, process.platform, process.env), 'openai/gpt-5.5', { interrupt: new AbortController().signal, stepTimeoutMs: 120_000, consented: false })).rejects.toThrow(
      'The model "openai/gpt-5.5" cannot be probed: it is not served by a managed server, an OpenAI-compatible server or an Ollama server. Configured models: chatgpt/gpt-5.5, openai/gpt-5.5.',
    );
  });

  it('starts a managed server of the command line under the stem _cli-probe-<provider>', async (context) => {
    const paths = momongaLayout(homeWith(context, undefined).home, process.platform, process.env);
    const ports = { platform: 'darwin', endpointScope: async () => ({ form: 'unix' }) as const } as const;

    expect(path.basename((await cliProbeInstance(ports, paths, FM_SERVER, 'apple')).socketPath)).toBe('_cli-probe-apple.sock');
  });

  it('gives the probe of a server that offers the pipe form a named pipe with the random part of the home on win32, and refuses one that offers only Unix sockets there', async () => {
    const paths = momongaLayout('C:\\Users\\Alice', 'win32', {});
    const scope = { form: 'pipe', token: '0123456789abcdef0123456789abcdef' } as const;
    const ports = { platform: 'win32', endpointScope: async () => scope } as const;
    const loom = { ...FM_SERVER, id: 'loom', endpoint: { forms: ['pipe'] } } as const;

    expect((await cliProbeInstance(ports, paths, loom, 'loom')).socketPath).toBe(pipePathFor(scope, 'managed-_cli-probe-loom'));
    await expect(cliProbeInstance(ports, paths, FM_SERVER, 'apple')).rejects.toThrow(/cannot be used on win32/);
  });
});
