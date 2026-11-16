import { describe, expect, it } from 'vitest';
import { modelFieldRows, runModelFields, runServerFields, serverFieldRows } from '../src/tui/models/fields.ts';
import type { FieldRow } from '../src/tui/models/fields.ts';
import { S3, S4, threeModels } from './models-shell-harness.ts';
import { NO, YES, flowOf } from './tui-models-harness.ts';

const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const CONNECTIONS = {
  ollama: { adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'm', capabilities: CAPABILITIES }] },
  chat: { adapter: 'chat-completions', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'm', capabilities: CAPABILITIES }] },
  responses: { adapter: 'open-responses', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', models: [{ id: 'm', capabilities: CAPABILITIES }] },
  anthropic: { adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', models: [{ id: 'm', capabilities: CAPABILITIES }] },
  plan: S3.models.connections[0] as Record<string, unknown>,
  managed: S4.models.connections[0] as Record<string, unknown>,
} as const;

const editorsOf = (rows: readonly FieldRow[]): Record<string, string> => Object.fromEntries(rows.map((row) => [row.label, row.editor]));

const labelsOf = (rows: readonly FieldRow[]): string[] => rows.map((row) => row.label);

describe('the fields the edit flows offer (4.9.2)', () => {
  it('every row of the table opens the editor its kind says', async (context) => {
    expect(editorsOf(serverFieldRows(CONNECTIONS.anthropic))).toEqual({
      API: 'choice',
      Address: 'text',
      Socket: 'text',
      Key: 'key',
      Billing: 'choice',
      'API version': 'choice',
      'Who answers': 'choice',
      'Idempotency key header': 'text',
      'Concurrent requests': 'number',
      'Wait for a free slot': 'number',
    });
    expect(editorsOf(serverFieldRows(CONNECTIONS.plan))).toMatchObject({ 'Plan account': 'account' });
    expect(editorsOf(serverFieldRows(CONNECTIONS.managed))).toMatchObject({ 'Server program': 'program', 'Program file': 'file', 'Start wait': 'minutes' });
    expect(editorsOf(modelFieldRows(CONNECTIONS.anthropic))).toEqual({
      'Concurrent requests': 'number',
      'Wait for a free slot': 'number',
      'Context window': 'number',
      'Output limit': 'number',
      'Structured output': 'choice',
      'JSON mode': 'choice',
      'Token counting': 'choice',
      'Source of the numbers': 'choice',
      Streaming: 'toggle',
      'Stop sequences': 'toggle',
      'Image input': 'toggle',
      'Parallel tool calls': 'toggle',
      'Usage reported': 'toggle',
      'Image tokens': 'group',
      'Allowed tool forms': 'choices',
      'Schema dialect': 'text',
      'Token count error': 'number',
      Reasoning: 'variant',
      'Prompt cache': 'variant',
      Sampling: 'variant',
    });
    expect(editorsOf(modelFieldRows(CONNECTIONS.chat))).toMatchObject({ 'Tool calling': 'choice', 'Output limit field': 'choice', 'Prompt cache': 'group' });

    const toggled = flowOf(context, threeModels(), [{ pick: /^Streaming/ }, { pick: 'no' }, YES, { pick: /^Reasoning/ }, { pick: 'reasoning_effort' }, { pick: 'low' }, YES, { pick: /^Image tokens/ }, { type: '750' }, { type: '1600' }, { type: '1' }]);
    await runModelFields(toggled.context, 'ollama/qwen3.8:27b');
    expect(toggled.picks().find((pick) => pick.title === 'Streaming')?.rows).toEqual(['yes', 'no', 'not declared']);
    expect(toggled.picks().find((pick) => pick.title === 'Reasoning')?.rows).toEqual(['none', 'reasoning_effort', 'Remove the value']);
    expect(toggled.prompts().map((prompt) => prompt.title)).toEqual(['Pixels per image token:', 'Largest image:', 'Smallest image:']);
    expect(toggled.infos[0]).toBe('Set Streaming of qwen3.8:27b to no.');
    expect(toggled.infos.at(-1)).toMatch(/capabilities\.imageTokens is declared but capabilities\.imageInput is false/);
    expect(toggled.picks().at(-1)?.rows).not.toEqual(['No', 'Yes']);
    const written = toggled.written() as { models: { connections: { models: { capabilities: Record<string, unknown> }[] }[] } };
    expect(written.models.connections[0]?.models[1]?.capabilities).toMatchObject({ streaming: false, reasoning: { control: 'reasoning_effort', lowest: 'low' } });
    expect(toggled.picks()[0]?.rows.find((row) => row.startsWith('Context window'))).toBe('Context window  32768');
    expect(toggled.picks()[0]?.rows.find((row) => row.startsWith('Tool calling'))).toBeUndefined();
    expect(toggled.picks()[0]?.rows.find((row) => row.startsWith('Parallel tool calls'))).toBe('Parallel tool calls  not declared');
  });

  it('a value that makes the file unloadable shows the sentence of the loader and writes nothing', async (context) => {
    const harness = flowOf(context, threeModels(), [{ pick: /^Context window/ }, { type: '' }]);
    const before = harness.bytes();
    await runModelFields(harness.context, 'lmstudio/gemma-3-4b');
    expect(harness.picks().find((pick) => pick.rows.join() === 'No,Yes')).toBeUndefined();
    expect(harness.infos).toHaveLength(1);
    expect(harness.infos[0]).toBe("invalid settings at /models/connections/1/models/0/capabilities: must have required property 'contextWindow'");
    expect(harness.bytes()).toBe(before);

    const declined = flowOf(context, threeModels(), [{ pick: /^Billing/ }, { pick: 'metered' }, NO]);
    await runServerFields(declined.context, 'lmstudio');
    expect(declined.bytes()).toBe(before);
  });

  it('a field the kind of the server does not allow is not offered', () => {
    expect(labelsOf(serverFieldRows(CONNECTIONS.ollama))).toEqual(['API', 'Address', 'Socket', 'Billing', 'Who answers', 'Idempotency key header', 'Concurrent requests', 'Wait for a free slot']);
    expect(labelsOf(modelFieldRows(CONNECTIONS.ollama))).not.toContain('Output limit field');
    expect(labelsOf(modelFieldRows(CONNECTIONS.ollama))).not.toContain('Tool calling');
    expect(labelsOf(serverFieldRows(CONNECTIONS.chat))).not.toContain('API version');
    expect(labelsOf(serverFieldRows(CONNECTIONS.plan))).not.toContain('API');
    expect(labelsOf(serverFieldRows(CONNECTIONS.managed))).toEqual(['Server program', 'Program file', 'Start wait', 'Billing', 'Who answers', 'Idempotency key header', 'Concurrent requests', 'Wait for a free slot']);
    expect(labelsOf(modelFieldRows(CONNECTIONS.managed))).toEqual(['Concurrent requests', 'Wait for a free slot', 'Tool calling', 'Context window', 'Output limit', 'Output limit field']);
  });

  it('the labels are the label column of the table, in its order', () => {
    expect(labelsOf(serverFieldRows(CONNECTIONS.responses))).toEqual(['API', 'Address', 'Socket', 'Key', 'Billing', 'Who answers', 'Idempotency key header', 'Concurrent requests', 'Wait for a free slot']);
    expect(labelsOf(modelFieldRows(CONNECTIONS.responses))).toEqual([
      'Concurrent requests',
      'Wait for a free slot',
      'Tool calling',
      'Context window',
      'Output limit',
      'Structured output',
      'JSON mode',
      'Token counting',
      'Source of the numbers',
      'Streaming',
      'Stop sequences',
      'Image input',
      'Parallel tool calls',
      'Usage reported',
      'Image tokens',
      'Allowed tool forms',
      'Schema dialect',
      'Token count error',
      'Reasoning',
      'Prompt cache',
      'Sampling',
      'Output limit field',
      'System role',
      'Tool placement',
      'Input kinds',
    ]);
  });
});
