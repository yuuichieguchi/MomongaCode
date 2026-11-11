import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KEY_TABLE } from '../../src/tui/keys/table.ts';
import { defaultTuiSettings } from '@momonga/config';
import { pollUntil } from '@momonga/testkit';
import { RepairFlow, RepairScreen } from '../../src/tui/screen/repair.tsx';
import { createScreenInput } from '../../src/tui/screen/input.ts';
import type { TerminalEvent } from '../../src/tui/terminal/events.ts';

const named = (name: string): TerminalEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, super: false, hyper: false, meta: false }) as TerminalEvent;

describe('the repair screen', () => {
  it('names the file and the reason, opens the file at Enter and quits at Esc', async () => {
    const input = createScreenInput();
    const asked: string[] = [];
    const { lastFrame, unmount } = render(
      <RepairScreen broken={{ kind: 'broken', file: '/h/.momonga/settings.json', message: '/h/.momonga/settings.json: invalid settings at /tui/screen: must be one of fullscreen, scrollback' }} input={input} keys={DEFAULT_KEY_TABLE} onOpen={() => asked.push('open')} onQuit={() => asked.push('quit')} />,
    );
    expect(lastFrame()).toContain('invalid settings at /tui/screen');
    expect(lastFrame()).toContain('Open the settings file');
    expect(lastFrame()).toContain('No session starts until the file loads.');
    input.push([named('enter')]);
    expect(asked).toEqual(['open']);
    input.push([named('escape')]);
    expect(asked).toEqual(['open', 'quit']);
    unmount();
  });

  it('offers no open row when the file that does not load is not known', () => {
    const input = createScreenInput();
    const asked: string[] = [];
    const { lastFrame, unmount } = render(<RepairScreen broken={{ kind: 'broken', file: undefined, message: 'm' }} input={input} keys={DEFAULT_KEY_TABLE} onOpen={() => asked.push('open')} onQuit={() => asked.push('quit')} />);
    expect(lastFrame()).not.toContain('Open the settings file');
    input.push([named('enter')]);
    expect(asked).toEqual([]);
    unmount();
  });
});

describe('the repair flow', () => {
  it('reads the settings again after the editor returns and ends with them once the file loads', async () => {
    const input = createScreenInput();
    const ended: string[] = [];
    let reads = 0;
    const { unmount } = render(
      <RepairFlow
        first={{ kind: 'broken', file: '/h/s.json', message: 'broken' }}
        input={input}
        keys={DEFAULT_KEY_TABLE}
        open={async () => ({ kind: 'opened' })}
        reread={async () => {
          reads += 1;
          return { kind: 'loaded', settings: defaultTuiSettings(), sources: { theme: 'default', notify: 'default', screenReader: 'default', reducedMotion: 'default', screen: 'default', mouse: 'default', copyOnSelect: 'default', attachFileMentions: 'default' } };
        }}
        done={(outcome) => ended.push(outcome.kind)}
        failed={(error) => ended.push(String(error))}
      />,
    );
    input.push([named('enter')]);
    await pollUntil(() => ended.length > 0, { description: 'the flow ends', boundMs: 2000 });
    expect(reads).toBe(1);
    expect(ended).toEqual(['loaded']);
    unmount();
  });
});
