import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { createSlashRegistry } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const MARKER = 'f'.repeat(64);

const contextWith = (answer: (name: string) => Promise<void>) => {
  const infos: string[] = [];
  const asked: string[] = [];
  const backend = {
    ignoreMarker: async (name: string) => {
      asked.push(name);
      await answer(name);
    },
  };
  const context = { backend, info: (text: string) => void infos.push(text) } as unknown as SlashContext;
  return { context, infos, asked };
};

describe('T17 (d) /markers ignore is a slash command of the interactive session (decision 45 A)', () => {
  it('is registered and sends the whole marker name to the runtime through the backend', async () => {
    const markers = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('markers');
    expect(markers).toBeDefined();
    const { context, asked } = contextWith(async () => undefined);
    await markers?.run(`ignore ${MARKER}`, context);
    expect(asked).toEqual([MARKER]);
  });

  it('shows the runtime answer for a name that is not an unsettled marker', async () => {
    const markers = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('markers');
    const { context, infos } = contextWith(async () => {
      throw new Error('no unsettled marker has that name');
    });
    await markers?.run('ignore not-a-marker', context).catch(() => undefined);
    expect(infos.join('\n')).toContain('no unsettled marker has that name');
  });

  it('there is no CLI subcommand markers, so the model Bash tool cannot run it', () => {
    const program = fs.readFileSync(path.join(ROOT, 'packages/cli/src/program.ts'), 'utf8');
    expect(fs.existsSync(path.join(ROOT, 'packages/cli/src/tui/commands/markers.ts'))).toBe(true);
    expect(program).not.toMatch(/\.command\(['"]markers/);
  });

  it('the runtime has the route POST /v1/markers/:name/ignore and the client calls it', () => {
    const service = path.join(ROOT, 'packages/runtime/src/service');
    const routes = fs.readdirSync(service).map((name) => fs.readFileSync(path.join(service, name), 'utf8')).join('\n');
    expect(routes).toContain('/v1/markers/:name/ignore');
    expect(fs.readFileSync(path.join(ROOT, 'packages/cli/src/client/runtime-client.ts'), 'utf8')).toContain('ignoreMarker');
  });

  it('(i) decision 51 A: a headless run offers no flag or setting to ignore a marker', () => {
    const sources = ['packages/cli/src/program.ts', 'packages/cli/src/run/headless.ts'].map((relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
    expect(sources).not.toMatch(/ignore-marker|ignoreMarker|markers ignore/i);
  });
});
