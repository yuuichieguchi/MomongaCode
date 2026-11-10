import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUserModels } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { cliProbeInstance, probeModel, probeSubjectOf } from '../src/commands/gateway.ts';
import type { CliPorts } from '../src/ports.ts';
import { S3, homeWith, threeModels } from './models-shell-harness.ts';

describe('momonga gateway probe <model>', () => {
  it('resolves what a person types by the typed rule, the display name included', (context) => {
    const { resolved } = loadUserModels({ home: homeWith(context, threeModels()).home });

    expect(probeSubjectOf(resolved, 'ollama/gemma-3-4b')).toMatchObject({ canon: 'ollama/gemma-3-4b:latest', display: 'ollama/gemma-3-4b' });
    expect(probeSubjectOf(resolved, 'qwen3.8:27b')).toMatchObject({ canon: 'ollama/qwen3.8:27b', display: 'qwen3.8:27b' });
    expect(() => probeSubjectOf(resolved, 'gemma-3-4b')).toThrow('The model "gemma-3-4b" is served by two servers: ollama/gemma-3-4b, lmstudio/gemma-3-4b. Write one of them.');
  });

  it('refuses a model that cannot be probed with the sentence that names it and the configured models', async (context) => {
    const at = homeWith(context, S3);
    const ports = { home: at.home } as unknown as CliPorts;

    await expect(probeModel(ports, momongaLayout(at.home), 'openai/gpt-5.5', { interrupt: new AbortController().signal })).rejects.toThrow(
      'The model "openai/gpt-5.5" cannot be probed: it is not served by a managed server, an OpenAI-compatible server or an Ollama server. Configured models: chatgpt/gpt-5.5, openai/gpt-5.5.',
    );
  });

  it('starts a managed server of the command line under the stem _cli-probe-<provider>', (context) => {
    const paths = momongaLayout(homeWith(context, undefined).home);

    expect(path.basename(cliProbeInstance(paths, 'apple').socketPath)).toBe('_cli-probe-apple.sock');
  });
});
