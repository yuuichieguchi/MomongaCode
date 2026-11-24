import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTuiSettings } from '@momonga/config';
import { systemTiming } from '@momonga/foundation';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { App } from '../../src/tui/app.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import { createSlashRegistry } from '../../src/tui/slash.ts';
import { fakeBackend, listedEntryOf, capabilitiesOf, runView } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { PROBING_PLAN } from '../fake-models-listing.ts';
import { freshHome } from '../fresh-home.ts';
import { PLAN_TEST_TIMEOUT_MS } from '../fake-plan-gateway.tsx';
import { KEYS, renderObservable, settleAtOnce, untilFrame, untilOutput } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP = { version: '1.2.3', home: '/Users/ada' };
const VERSION = 'MomongaCode v1.2.3';
const CWD = '/work/project';
const OTHER = 'scripted/other-model';
const REASONING = { control: 'reasoning_effort', lowest: 'low' } as const;
const DECLARED: FakeBackendOptions['reasoning'] = { [SCRIPTED_MODEL]: REASONING, [OTHER]: REASONING };
const SCREEN = { columns: 100, rows: 30, screen: 'scrollback' as const };
const REFUSED = '/work/project/.momonga/settings.json: Unexpected end of JSON input';

const settings = (given: Partial<ResolvedTuiSettings> = {}): TuiSettingsPort => ({
  initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: true, screen: 'scrollback', mouse: true, copyOnSelect: true, attachFileMentions: true, ...given },
  save: async () => undefined,
});

const modelLinesOf = (frame: string): string[] =>
  frame.split('\n').flatMap((row) => {
    const at = row.indexOf('model:');
    return at === -1 ? [] : [row.slice(at).replace(/[\s│]+$/, '')];
  });

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

const writtenBlocks = (frames: readonly string[]): string[] => {
  const blocks: string[] = [];
  let live = '';
  for (const frame of frames) {
    if (live !== '' && frame.length > live.length && frame.endsWith(live)) {
      blocks.push(frame.slice(0, frame.length - live.length));
    } else {
      live = frame;
    }
  }
  return blocks;
};

describe('Decision 7: scrollback holds the start screen until connected model capabilities are read', () => {
  it.each([
    ['scrollback', {}],
    ['screen-reader mode', { screenReader: true }],
  ] as const)('in %s, holds banner and following warning through probing, then writes banner first and once with effort', async (_name, tui) => {
    const capabilities = Promise.withResolvers<void>();
    const base = fakeBackend({
      reasoning: DECLARED,
      probing: [SCRIPTED_MODEL],
      modelPending: capabilities.promise,
      trustItems: { items: [], refused: [REFUSED] },
    });
    let modelCalls = 0;
    const backend = {
      ...base,
      model: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return listedEntryOf(SCRIPTED_MODEL, PROBING_PLAN);
        }
        await capabilities.promise;
        return listedEntryOf(SCRIPTED_MODEL, capabilitiesOf({ reasoning: REASONING }));
      },
    };
    const app = renderObservable(
      <App
        backend={backend}
        terminal={fakeScreenTerminal(SCREEN)}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings(tui)}
        onExit={() => undefined}
      />,
    );
    await untilFrame(app, (frame) => frame.includes('model: scripted-model') && frame.includes('measuring'));
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 60));
    expect(app.frames.join('\n')).not.toContain('effort: medium');
    // Neither banner nor refused warning should have been handed to stdout before probing completed.
    expect(writtenBlocks(app.frames).filter((block) => block.includes(VERSION))).toEqual([]);
    expect(writtenBlocks(app.frames).filter((block) => block.includes(REFUSED))).toEqual([]);

    capabilities.resolve();
    await untilFrame(app, (frame) => !frame.includes(VERSION));
    const handed = writtenBlocks(app.frames);
    expect(handed.some((block) => block.includes(VERSION) && block.includes('effort: medium'))).toBe(true);
    expect(handed.filter((block) => block.includes(VERSION))).toHaveLength(1);
    const writtenText = handed.join('\n');
    expect(writtenText.indexOf(VERSION)).toBeLessThan(writtenText.indexOf(REFUSED));
    app.unmount();
  });

  it('on capability read failure, writes the start screen with blank effort and the failure warning', async () => {
    const fail = Promise.withResolvers<void>();
    const base = fakeBackend({ reasoning: DECLARED, probing: [SCRIPTED_MODEL] });
    const backend = {
      ...base,
      model: async () => {
        await fail.promise;
        throw new Error('gateway down');
      },
    };
    const app = renderObservable(
      <App
        backend={backend}
        terminal={fakeScreenTerminal(SCREEN)}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    await untilFrame(app, (frame) => frame.includes('model: scripted-model') && frame.includes('mode: manual'));
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 40));
    expect(writtenBlocks(app.frames).filter((block) => block.includes(VERSION))).toEqual([]);

    fail.resolve();
    await untilFrame(app, (frame) => !frame.includes(VERSION) && !frame.includes('gateway down'));
    const handed = writtenBlocks(app.frames);
    expect(handed.filter((block) => block.includes(VERSION))).toHaveLength(1);
    const bannerWritten = handed.find((block) => block.includes(VERSION)) ?? '';
    expect(bannerWritten).not.toContain('effort:');
    const rows = bannerWritten.split('\n');
    const vRow = rows.findIndex((row) => row.includes(VERSION));
    const textCol = rows[vRow]!.indexOf(VERSION);
    expect(rows[vRow + 2]?.slice(textCol).replace(/[│\s]+/g, '')).toBe('');
    expect(rows[vRow + 3]?.slice(textCol)).toContain(CWD);
    const writtenText = handed.join('\n');
    expect(writtenText.indexOf(VERSION)).toBeLessThan(writtenText.indexOf('gateway down'));
    app.unmount();
  });

  it('shows startup model warnings on --continue, unlike handover adoption', async () => {
    const base = fakeBackend({
      modelFailure: new Error('gateway offline'),
      conversations: [
        {
          session: { id: 'conv-1', cwd: CWD },
          firstPrompt: 'hello',
          runs: [{ id: 'run-1', status: 'COMPLETED', frames: [] }],
        },
      ],
    });
    const app = renderObservable(
      <App
        backend={base}
        terminal={fakeScreenTerminal(SCREEN)}
        initialMode={undefined}
        reopen={{ kind: 'newest' }}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    await untilFrame(app, 'gateway offline');
    app.unmount();
  });

  it('ignores stale model read and probing results after switching to another model with /model', async () => {
    const firstModelRead = Promise.withResolvers<void>();
    const secondModelRead = Promise.withResolvers<void>();
    const slash = createSlashRegistry([
      ...DEFAULT_SLASH_COMMANDS,
      {
        name: 'note-test',
        description: 'append note',
        needsSession: false,
        run: async (_args, context) => {
          context.info('after model');
        },
      },
    ]);
    const base = fakeBackend({ reasoning: DECLARED, models: [SCRIPTED_MODEL, OTHER] });
    let current = SCRIPTED_MODEL;
    const setModelOrig = base.setModel;
    const backend = {
      ...base,
      setModel: async (chosen: string, effort?: Parameters<typeof setModelOrig>[1]) => {
        current = chosen;
        return setModelOrig(chosen, effort);
      },
      model: async () => {
        const target = current;
        if (target === SCRIPTED_MODEL) {
          await firstModelRead.promise;
          throw new Error('old model failed');
        }
        await secondModelRead.promise;
        return listedEntryOf(target, capabilitiesOf({ reasoning: REASONING }));
      },
    };
    const app = renderObservable(
      <App
        backend={backend}
        terminal={fakeScreenTerminal(SCREEN)}
        slash={slash}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    await untilFrame(app, (frame) => frame.includes('model: scripted-model') && frame.includes('mode: manual'));
    app.stdin.write('/model other-model');
    await untilFrame(app, '> /model other-model');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (frame) => modelLinesOf(frame).some((line) => line.includes('other-model')));

    app.stdin.write('/note-test');
    await untilFrame(app, '> /note-test');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'after model');

    // Resolve stale read from old model with an error; it must NOT release the banner or emit a warning.
    firstModelRead.resolve();
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 60));
    expect(app.frames.join('\n')).not.toContain('old model failed');
    expect(writtenBlocks(app.frames).filter((block) => block.includes(VERSION))).toEqual([]);

    // Now finish new model read.
    secondModelRead.resolve();
    await untilFrame(app, (frame) => !frame.includes(VERSION));
    const handed = writtenBlocks(app.frames).filter((block) => block.includes(VERSION));
    expect(handed).toHaveLength(1);
    expect(handed[0]).toContain('other-model');
    expect(handed[0]).toContain('effort: medium');
    app.unmount();
  });

  it('does not re-hold entries when connecting a model after an unconnected start screen was already handed to scrollback', async () => {
    const place = { home: freshHome(), project: CWD };
    const secondRead = Promise.withResolvers<void>();
    const slash = createSlashRegistry([
      ...DEFAULT_SLASH_COMMANDS,
      {
        name: 'connect-test',
        description: 'test connecting a model',
        needsSession: false,
        run: async (_args, context) => {
          await context.backend.openSession(SCRIPTED_MODEL);
          await context.refreshConnection();
          context.info('after connect note');
        },
      },
    ]);
    const base = fakeBackend({ models: [], settingsPlace: { home: place.home, projectDir: place.project } });
    const backend = {
      ...base,
      model: async () => {
        await secondRead.promise;
        return listedEntryOf(SCRIPTED_MODEL, capabilitiesOf());
      },
    };
    const app = renderObservable(
      <App
        backend={backend}
        terminal={fakeScreenTerminal(SCREEN)}
        slash={slash}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    // Dismiss the connect-a-model panel, then write a note so the unconnected banner is handed to scrollback.
    await untilFrame(app, 'Connect a model to start');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, 'no model connected');
    app.stdin.write('hello');
    await untilFrame(app, '> hello');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (frame) => !frame.includes(VERSION));
    app.stdin.write(KEYS.ctrlC);
    await untilFrame(app, (frame) => !frame.includes('> hello'));

    // Simulate adding a model in settings + connecting while backend.model() stays pending.
    const nextModels = [SCRIPTED_MODEL];
    backend.models = async () => nextModels.map((id) => listedEntryOf(id, capabilitiesOf()));
    app.stdin.write('/connect-test');
    await untilFrame(app, '> /connect-test');
    app.stdin.write(KEYS.enter);

    // The note written after connecting must flush to scrollback without waiting for secondRead!
    await untilOutput(app, 'after connect note');
    await untilFrame(app, (frame) => !frame.includes('after connect note'));
    secondRead.resolve();
    expect(occurrences(writtenBlocks(app.frames).join('\n'), VERSION)).toBe(1);
    expect(writtenBlocks(app.frames).some((block) => block.includes('after connect note'))).toBe(true);
    app.unmount();
  });

  it('releases the hold and stops measuring if the active model is removed from settings and refreshConnection runs', async () => {
    let available = [SCRIPTED_MODEL];
    const readHeld = Promise.withResolvers<void>();
    const slash = createSlashRegistry([
      ...DEFAULT_SLASH_COMMANDS,
      {
        name: 'refresh-test',
        description: 'test refresh',
        needsSession: false,
        run: async (_args, context) => {
          await context.refreshConnection();
          context.info('after refresh');
        },
      },
    ]);
    const base = fakeBackend({ models: [SCRIPTED_MODEL], probing: [SCRIPTED_MODEL] });
    const backend = {
      ...base,
      models: async () => available.map((id) => listedEntryOf(id, capabilitiesOf())),
      model: async () => {
        await readHeld.promise;
        return listedEntryOf(SCRIPTED_MODEL, PROBING_PLAN);
      },
    };
    const app = renderObservable(
      <App
        backend={backend}
        terminal={fakeScreenTerminal(SCREEN)}
        slash={slash}
        initialMode={undefined}
        now={Date.now}
        timers={settleAtOnce(systemTiming)}
        startup={STARTUP}
        tuiSettings={settings()}
        onExit={() => undefined}
      />,
    );
    await untilFrame(app, (frame) => frame.includes('model: scripted-model') && frame.includes('mode: manual'));
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 40));
    expect(writtenBlocks(app.frames).filter((block) => block.includes(VERSION))).toEqual([]);

    available = [];
    app.stdin.write('/refresh-test');
    await untilFrame(app, '> /refresh-test');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (frame) => !frame.includes(VERSION));
    readHeld.resolve();
    const handed = writtenBlocks(app.frames);
    expect(handed.filter((block) => block.includes(VERSION))).toHaveLength(1);
    expect(handed.join('\n')).toContain('after refresh');
    app.unmount();
  });
});
