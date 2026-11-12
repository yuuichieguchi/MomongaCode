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

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('the scrollback hand-off of the history view', () => {
  it('writes no row before the background answer is known, then writes each settled row once, without <Static>', async () => {
    const store = createTranscriptStore();
    appendEntry(store, { kind: 'info', text: 'alpha row' });
    appendEntry(store, { kind: 'info', text: 'beta row' });
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, ROW_SCHEDULE), 40);
    const feed = createHistoryFeed();
    const view = (ready: boolean) => <HistoryView store={store} source={source} feed={feed} ready={ready} timers={systemTiming} columns={40} />;
    const app = renderObservable(view(false));
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 50));
    expect(app.frames.join('\n')).not.toContain('alpha row');
    app.rerender(view(true));
    await untilOutput(app, 'beta row');
    appendEntry(store, { kind: 'info', text: 'gamma row' });
    app.rerender(view(true));
    await untilOutput(app, 'gamma row');
    await new Promise<void>((resolve) => systemTiming.setTimeout(resolve, 50));
    const output = app.frames.join('\n');
    expect([occurrences(output, 'alpha row'), occurrences(output, 'beta row'), occurrences(output, 'gamma row')]).toEqual([1, 1, 1]);
    app.unmount();
  });
});
