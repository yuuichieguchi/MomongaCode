import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutputStyle } from '@momonga/protocol';
import { testKernelLock } from '@momonga/testkit';
import { styleCommand, STYLE_IN_FORCE_MARK } from '../src/tui/commands/style.ts';
import type { SlashContext } from '../src/tui/slash.ts';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const makeContext = async (options: { current?: OutputStyle; choice?: { index: number; alt?: boolean } }) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'momonga-style-cmd-'));
  dirs.push(home);
  const settingsFile = path.join(home, 'settings.json');
  const infos: string[] = [];
  const applied: Array<OutputStyle | null> = [];
  let pickerRequest: unknown;

  const context = {
    outputStyle: options.current,
    setOutputStyle: async (style: OutputStyle | null) => {
      applied.push(style);
    },
    info: (text: string) => {
      infos.push(text);
    },
    wait: async <T,>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    backend: {
      modelsHost: () => ({ home, settingsFile, lock: () => testKernelLock() }),
    },
    overlays: {
      closeScreen: () => undefined,
      choose: async (request: unknown) => {
        pickerRequest = request;
        return options.choice;
      },
    },
  } as unknown as SlashContext;

  return { context, home, settingsFile, infos, applied, getPickerRequest: () => pickerRequest };
};

describe('/style command', () => {
  it('saves style and updates session when given a style name', async () => {
    const { context, settingsFile, infos, applied } = await makeContext({});
    await styleCommand.run('concise', context);
    expect(applied).toEqual(['concise']);
    expect(infos).toEqual(['style: concise; saved']);
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({ output: { style: 'concise' } });
  });

  it('applies to session only when --session is passed', async () => {
    const { context, settingsFile, infos, applied } = await makeContext({});
    await styleCommand.run('explanatory --session', context);
    expect(applied).toEqual(['explanatory']);
    expect(infos).toEqual(['style: explanatory; this session only']);
    await expect(readFile(settingsFile, 'utf8')).rejects.toThrow();
  });

  it('removes saved style and restores standard on reset', async () => {
    const { context, settingsFile, infos, applied } = await makeContext({ current: 'concise' });
    await styleCommand.run('concise', context);
    await styleCommand.run('reset', context);
    expect(applied).toEqual(['concise', null]);
    expect(infos.at(-1)).toBe('style: standard; the saved output style is removed');
    expect(JSON.parse(await readFile(settingsFile, 'utf8'))).toEqual({});
  });

  it('rejects unknown style names and lists available options', async () => {
    const { context, infos, applied } = await makeContext({});
    await styleCommand.run('verbose', context);
    expect(applied).toEqual([]);
    expect(infos).toEqual(['unknown style verbose; available: standard, concise, explanatory']);
  });

  it('opens picker with in-use mark and supports session-only alt selection', async () => {
    const { context, infos, applied, getPickerRequest } = await makeContext({
      current: 'explanatory',
      choice: { index: 1, alt: true },
    });
    await styleCommand.run('', context);
    const req = getPickerRequest() as { rows: Array<{ label: string; value?: string }> };
    expect(req.rows.find((row) => row.label === 'explanatory')?.value).toBe(STYLE_IN_FORCE_MARK);
    expect(applied).toEqual(['concise']);
    expect(infos).toEqual(['style: concise; this session only']);
  });

  it('marks saved output.style as in use when session has no override', async () => {
    const { context, getPickerRequest } = await makeContext({});
    await styleCommand.run('concise', context);
    await styleCommand.run('', context);
    const req = getPickerRequest() as { rows: Array<{ label: string; value?: string }> };
    expect(req.rows.find((row) => row.label === 'concise')?.value).toBe(STYLE_IN_FORCE_MARK);
  });
});
