import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runModelsForm, listModels } from '../src/commands/models.ts';
import type { FormInput } from '../src/commands/models.ts';
import { windowProblem, wholeNumberWithin } from '../src/models-check.ts';
import { windowProblem as tuiWindowProblem } from '../src/tui/models/texts.ts';
import { LLAMA_SERVER, OLLAMA_ADDRESS, S3, documentOf, homeWith, listingOf, ollamaFound, shellOf } from './models-shell-harness.ts';

const input = (args: readonly string[], options: FormInput['options'] = {}): FormInput => ({ args: [...args], options });

describe('the forms of momonga models map every outside text to their own errors (cli-commands-C08)', () => {
  it('exits 2 and names the file when the dialects file is not JSON', async (context) => {
    const home = homeWith(context, undefined);
    const file = path.join(home.home, 'dialects.json');
    fs.writeFileSync(file, '{ not json');
    const harness = shellOf(home);

    expect(await runModelsForm(harness.shell, 'dialects set', input([], { file, yes: true }))).toBe(2);

    expect(harness.err()).toContain(file);
  });

  it('exits 2 when the arguments of a program are not a JSON list', async (context) => {
    const harness = shellOf(homeWith(context, undefined));

    expect(await runModelsForm(harness.shell, 'set-program', input(['llama-server', 'args', '[not json'], { yes: true }))).toBe(2);

    expect(harness.err()).toContain('args');
  });

  it('refuses a --window above the ceiling of the picked model with the text the terminal UI shows', async (context) => {
    const harness = shellOf(homeWith(context, undefined), {
      found: () => [ollamaFound(OLLAMA_ADDRESS, ['long:7b'])],
      describe: async (_server, model) => ({ ...model, ceiling: 4096 }),
    });

    expect(await runModelsForm(harness.shell, 'add', input([], { model: 'long:7b', window: '8192', yes: true }))).toBe(2);

    expect(harness.err()).toContain(windowProblem(4096));
    expect(tuiWindowProblem).toBe(windowProblem);
    expect(wholeNumberWithin('8192', 4096)).toBeUndefined();
    expect(wholeNumberWithin('4096', 4096)).toBe(4096);
  });

  it('prints the state word of a plan model from the health the gateway reports', async (context) => {
    const home = homeWith(context, S3);
    const listed = listingOf(home.home);
    const harness = shellOf(home, { listing: () => ({ ...listed, data: listed.data.map((entry) => (entry.billing === 'plan' ? { ...entry, state: 'degraded' as const } : entry)) }) });

    await listModels(harness.shell, { json: false });

    expect(harness.out()).toMatch(/gpt-5\.5 {2}· {2}plan {2}· {2}degraded/);
  });

  it('adds the built-in fm server from the shell', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home, { programModel: 'system' });

    expect(await runModelsForm(harness.shell, 'add', input([], { builtin: 'fm', yes: true }))).toBe(0);

    const models = documentOf(home.settingsFile)['models'] as { connections: unknown[] };
    expect(models.connections).toEqual([{ adapter: 'managed', server: 'fm', models: [{ id: 'system' }] }]);
  });

  it('add-program without --model asks the declared program for its model and writes the model it names', async (context) => {
    const home = homeWith(context, undefined);
    const harness = shellOf(home, { programModel: 'qwen3-coder-30b' });

    expect(await runModelsForm(harness.shell, 'add-program', input([], { command: LLAMA_SERVER.command, arg: LLAMA_SERVER.args, readyPath: LLAMA_SERVER.readyPath, yes: true }))).toBe(0);

    expect(harness.programsAsked).toEqual([{ id: 'llama-server', ...LLAMA_SERVER }]);
    expect(documentOf(home.settingsFile)['models']).toEqual({ servers: { 'llama-server': LLAMA_SERVER }, connections: [{ adapter: 'managed', server: 'llama-server', models: [{ id: 'qwen3-coder-30b' }] }] });
  });
});
