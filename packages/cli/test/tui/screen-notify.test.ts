import { describe, expect, it } from 'vitest';
import { NOTIFY_MODES, UNSTORED_TUI_SETTINGS, noticeOf, signalDue } from '../../src/tui/screen/notify.ts';
import { TITLE_STATES } from '../../src/tui/terminal/title.ts';

const FOCUSES = [undefined, 'in', 'out'] as const;
const OSC9 = [true, false] as const;
const NEEDS_THE_PERSON = ['waiting for you', 'done', 'error'] as const;

const everyCase = () => NOTIFY_MODES.flatMap((notify) => FOCUSES.flatMap((focus) => TITLE_STATES.flatMap((state) => OSC9.map((osc9) => ({ notify, focus, state, osc9 })))));

describe('the notification setting', () => {
  it('has the values auto, bell and off in that order, and auto is the value without a settings file', () => {
    expect(NOTIFY_MODES).toEqual(['auto', 'bell', 'off']);
    expect(UNSTORED_TUI_SETTINGS.initial).toEqual({ theme: 'auto', notify: 'auto', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true });
  });
});

describe('when a signal is due', () => {
  it('covers all 90 cases of setting, focus, state and terminal', () => {
    expect(everyCase()).toHaveLength(90);
  });

  it('OffIsSilent: off gives no signal in any case', () => {
    for (const given of everyCase().filter((one) => one.notify === 'off')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('OnlyWhenReportedOut: no signal unless the last focus report was out, nor when nothing was reported', () => {
    for (const given of everyCase().filter((one) => one.focus !== 'out')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('OnlyOnChangeToNeedsPerson: no signal for ready or working', () => {
    for (const given of everyCase().filter((one) => one.state === 'ready' || one.state === 'working')) expect(signalDue(given), JSON.stringify(given)).toBe('none');
  });

  it('SignalKind: bell rings for every state that needs the person when focus is out, on any terminal', () => {
    for (const state of NEEDS_THE_PERSON) for (const osc9 of OSC9) expect(signalDue({ notify: 'bell', focus: 'out', state, osc9 }), `${state} ${String(osc9)}`).toBe('bell');
  });

  it('SignalKind: auto sends a desktop notification on a terminal that shows OSC 9', () => {
    for (const state of NEEDS_THE_PERSON) expect(signalDue({ notify: 'auto', focus: 'out', state, osc9: true }), state).toBe('notification');
  });

  it('SignalKind: auto rings the bell on a terminal that does not show OSC 9', () => {
    for (const state of NEEDS_THE_PERSON) expect(signalDue({ notify: 'auto', focus: 'out', state, osc9: false }), state).toBe('bell');
  });

  it('gives a signal in exactly the 12 cases of setting on, focus out and a state that needs the person', () => {
    expect(everyCase().filter((given) => signalDue(given) !== 'none')).toHaveLength(12);
  });
});

const CWD = '/tmp/work/myproject';
const PERMISSION = { heading: 'Permission requested: npm test', namesFolder: false };

describe('the text of the desktop notification', () => {
  it('says how long a completed run took and names the folder', () => {
    expect(noticeOf({ state: 'done', cwd: CWD, outcome: { kind: 'done', elapsedMs: 32000 }, waiting: undefined })).toBe('Run complete in 32s · myproject');
  });

  it('counts whole seconds, rounded down, always in seconds', () => {
    const doneIn = (elapsedMs: number) => noticeOf({ state: 'done', cwd: CWD, outcome: { kind: 'done', elapsedMs }, waiting: undefined });
    expect(doneIn(0)).toBe('Run complete in 0s · myproject');
    expect(doneIn(999)).toBe('Run complete in 0s · myproject');
    expect(doneIn(32999)).toBe('Run complete in 32s · myproject');
    expect(doneIn(754000)).toBe('Run complete in 754s · myproject');
  });

  it('says why a run failed when the reason is known', () => {
    expect(noticeOf({ state: 'error', cwd: CWD, outcome: { kind: 'error', reason: 'provider_error: the provider failed' }, waiting: undefined })).toBe('Run failed: provider_error: the provider failed · myproject');
  });

  it('gives only the first line of a reason of several lines', () => {
    expect(noticeOf({ state: 'error', cwd: CWD, outcome: { kind: 'error', reason: 'the gateway refused the run\ndetail: quota\nremedy: wait' }, waiting: undefined })).toBe('Run failed: the gateway refused the run · myproject');
  });

  it('says only that the run failed when no reason is known or the reason is blank', () => {
    for (const reason of [undefined, '', '   ', '\n\t']) expect(noticeOf({ state: 'error', cwd: CWD, outcome: { kind: 'error', reason }, waiting: undefined }), JSON.stringify(reason)).toBe('Run failed · myproject');
  });

  it('gives the heading of an approval of a command and of a file edit, then the folder', () => {
    expect(noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: PERMISSION })).toBe('Permission requested: npm test · myproject');
    expect(noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: { heading: 'Permission requested: Edit src/app.ts', namesFolder: false } })).toBe('Permission requested: Edit src/app.ts · myproject');
  });

  it('gives the heading of an approval of calls with an unknown effect, then the folder', () => {
    expect(noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: { heading: 'Effect unknown: Write /a.txt', namesFolder: false } })).toBe('Effect unknown: Write /a.txt · myproject');
  });

  it('gives the heading of a question from an MCP server, then the folder', () => {
    expect(noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: { heading: 'MCP server github asks for input (Pick a branch)', namesFolder: false } })).toBe('MCP server github asks for input (Pick a branch) · myproject');
  });

  it('gives the trust question without the folder after it', () => {
    expect(noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: { heading: 'Do you trust the files in /tmp/work/myproject?', namesFolder: true } })).toBe('Do you trust the files in /tmp/work/myproject?');
  });

  it('gives nothing for ready or working', () => {
    for (const state of ['ready', 'working'] as const) {
      expect(noticeOf({ state, cwd: CWD, outcome: undefined, waiting: undefined }), state).toBeUndefined();
      expect(noticeOf({ state, cwd: CWD, outcome: { kind: 'done', elapsedMs: 1000 }, waiting: undefined }), state).toBeUndefined();
    }
  });

  it('keeps the folder whole and stays within 255 bytes for a long command', () => {
    const text = noticeOf({ state: 'waiting for you', cwd: CWD, outcome: undefined, waiting: { heading: `Permission requested: ${'npm run build && '.repeat(30)}`, namesFolder: false } });
    expect(text?.endsWith('… · myproject')).toBe(true);
    expect(text?.startsWith('Permission requested: npm run build && npm run build')).toBe(true);
    expect(Buffer.byteLength(text ?? '', 'utf8')).toBe(255);
  });
});
