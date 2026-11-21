import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolishCommand, NOTHING_TO_POLISH, parsePolishArgs } from '../src/tui/commands/polish.ts';
import type { SlashContext } from '../src/tui/slash.ts';

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const makeContext = (lastAnswer?: string) => {
  const infos: string[] = [];
  const started: string[] = [];
  const context = {
    info: (text: string) => {
      infos.push(text);
    },
    startRun: async (text: string) => {
      started.push(text);
    },
    clipboard: {
      selected: () => undefined,
      lastAnswer: () => lastAnswer,
    },
  } as unknown as SlashContext;
  return { context, infos, started };
};

describe('/polish command', () => {
  it('parses file path and --audience options cleanly', () => {
    expect(parsePolishArgs('')).toEqual({ ok: true });
    expect(parsePolishArgs('docs/spec.md --audience 非エンジニア')).toEqual({
      ok: true,
      filePath: 'docs/spec.md',
      audience: '非エンジニア',
    });
    expect(parsePolishArgs('--audience="new hire" README.md')).toEqual({
      ok: true,
      filePath: 'README.md',
      audience: 'new hire',
    });
    expect(parsePolishArgs('--unknown foo').ok).toBe(false);
    expect(parsePolishArgs('a.md b.md').ok).toBe(false);
  });

  it('notifies when run with no args and no previous assistant answer', async () => {
    const { context, infos, started } = makeContext(undefined);
    await createPolishCommand().run('', context);
    expect(started).toEqual([]);
    expect(infos).toEqual([NOTHING_TO_POLISH]);
  });

  it('starts a polish run on the previous assistant answer when no file is given', async () => {
    const { context, infos, started } = makeContext('Previous draft answer.');
    await createPolishCommand().run('--audience 非エンジニア', context);
    expect(infos).toEqual([]);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain('Previous draft answer.');
    expect(started[0]).toContain('非エンジニア');
  });

  it('rejects missing files before starting a run and accepts readable files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'momonga-polish-'));
    dirs.push(dir);
    const existing = path.join(dir, 'spec.md');
    await writeFile(existing, '# Spec\n', 'utf8');

    const missingCtx = makeContext();
    await createPolishCommand().run(path.join(dir, 'missing.md'), missingCtx.context);
    expect(missingCtx.started).toEqual([]);
    expect(missingCtx.infos[0]).toMatch(/does not exist or is not readable/);

    const okCtx = makeContext();
    await createPolishCommand().run(existing, okCtx.context);
    expect(okCtx.infos).toEqual([]);
    expect(okCtx.started).toHaveLength(1);
    expect(okCtx.started[0]).toContain(existing);
  });
});
