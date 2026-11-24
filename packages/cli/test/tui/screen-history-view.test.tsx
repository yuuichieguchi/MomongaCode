import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { createHistoryFeed } from '../../src/tui/screen/history-feed.ts';
import { HistoryView } from '../../src/tui/screen/history-view.tsx';
import { createRowCache } from '../../src/tui/screen/row-cache.ts';
import { createTranscriptStore } from '../../src/tui/screen/store.ts';
import { sourceOf } from '../../src/tui/screen/viewport.ts';
import { appendEntry } from '../../src/tui/transcript.ts';
import { renderObservable, untilOutput } from '../ink-helpers.ts';
import { ROW_RENDERERS, ROW_SCHEDULE } from './screen-fakes.ts';
import type { BannerModel } from '../../src/tui/startup.tsx';

const bannerOf = (model: BannerModel) => ({ kind: 'banner' as const, banner: { config: { version: '1.2.3', home: '/h' }, model, cwd: '/h/project', notices: [], figure: false } });

const turnPassed = (): Promise<void> => new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 50));

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('the scrollback hand-off of the history view', () => {
  it('writes each settled row once after it is settled, without <Static>', async () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'alpha row' });
    appendEntry(store, { kind: 'info', text: 'beta row' });
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, ROW_SCHEDULE), 40);
    const feed = createHistoryFeed();
    const view = () => <HistoryView store={store} source={source} feed={feed} timers={systemTiming} columns={40} />;
    const app = renderObservable(view());
    await untilOutput(app, 'beta row');
    appendEntry(store, { kind: 'info', text: 'gamma row' });
    app.rerender(view());
    await untilOutput(app, 'gamma row');
    await turnPassed();
    const output = app.frames.join('\n');
    expect([occurrences(output, 'alpha row'), occurrences(output, 'beta row'), occurrences(output, 'gamma row')]).toEqual([1, 1, 1]);
    app.unmount();
  });

  it('hands nothing to the scrollback while the start screen has not read its model line or is reading capabilities, then writes the start screen first and once', async () => {
    const store = createTranscriptStore();
    appendEntry(store, bannerOf({ kind: 'unread' }), 'banner');
    appendEntry(store, { kind: 'notice', level: 'warning', text: 'refused settings file' });
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, ROW_SCHEDULE), 60);
    const feed = createHistoryFeed();
    const view = () => <HistoryView store={store} source={source} feed={feed} timers={systemTiming} columns={60} />;
    const app = renderObservable(view());
    await turnPassed();
    expect(feed.handed()).toBe(0);
    store.change('banner', () => bannerOf({ kind: 'connected', name: 'lab/model', reading: true }));
    app.rerender(view());
    await turnPassed();
    expect(feed.handed()).toBe(0);
    expect(app.lastFrame()).toContain('MomongaCode v1.2.3');
    expect(app.lastFrame()).toContain('refused settings file');
    store.change('banner', () => bannerOf({ kind: 'connected', name: 'lab/model' }));
    app.rerender(view());
    await untilOutput(app, 'model: lab/model');
    await turnPassed();
    expect(feed.handed()).toBe(2);
    const output = app.frames.join('\n');
    expect(output.indexOf('MomongaCode v1.2.3')).toBeLessThan(output.indexOf('refused settings file'));
    const written = app.frames.filter((frame) => frame.includes('model: lab/model'));
    expect(written.every((frame) => frame.indexOf('MomongaCode v1.2.3') < frame.indexOf('refused settings file'))).toBe(true);
    app.unmount();
  });

  it('hands the settled entries of a subagent view, which has no start screen, as before', async () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'child one' });
    appendEntry(store, { kind: 'info', text: 'child two' });
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, ROW_SCHEDULE), 40);
    const feed = createHistoryFeed();
    const app = renderObservable(<HistoryView store={store} source={source} feed={feed} timers={systemTiming} columns={40} />);
    await untilOutput(app, 'child two');
    await turnPassed();
    expect(feed.handed()).toBe(2);
    app.unmount();
  });
});
