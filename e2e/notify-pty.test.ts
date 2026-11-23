import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import type { FakeChatCompletionsServer } from '@momonga/testkit';
import { prepareProduct } from './support/product.ts';
import { answerTrust, spawnPty, untilRunEnds } from './support/pty.ts';
import type { KeyName, PtySession } from './support/pty.ts';
import { baseSettings, sandboxChoiceOf, startUpstream, writeSettingsFile } from './support/stack.ts';
import { textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const OSC9 = `${ESC}]9;`;
const FOCUS_REPORTING_ON = `${ESC}[?1004h`;
const FOCUS_REPORTING_OFF = `${ESC}[?1004l`;
const GHOSTTY = { TERM_PROGRAM: 'ghostty' } as const;

type Split = { readonly oscs: readonly string[]; readonly plain: string };

const splitOscs = (raw: string): Split => {
  const oscs: string[] = [];
  let plain = '';
  let at = 0;
  while (at < raw.length) {
    const start = raw.indexOf(`${ESC}]`, at);
    if (start === -1) {
      plain += raw.slice(at);
      break;
    }
    plain += raw.slice(at, start);
    const bel = raw.indexOf(BEL, start);
    const st = raw.indexOf(`${ESC}\\`, start);
    const ends = [bel === -1 ? Infinity : bel + 1, st === -1 ? Infinity : st + 2];
    const end = Math.min(...ends);
    if (end === Infinity) {
      oscs.push(raw.slice(start));
      break;
    }
    oscs.push(raw.slice(start, end));
    at = end;
  }
  return { oscs, plain };
};

const bellSignalsIn = (raw: string): number => [...splitOscs(raw).plain].filter((character) => character === BEL).length;

const countOf = (raw: string, needle: string): number => raw.split(needle).length - 1;

const escaped = (raw: string): string => JSON.stringify(raw);

const folderOf = (home: E2eHome): string => path.basename(home.project);

const titleTextOf = (state: string, home: E2eHome): string => `${state} · ${folderOf(home)} · momonga`;

const notificationOf = (state: string, home: E2eHome): string => `${OSC9}${titleTextOf(state, home)}${BEL}`;

const titleSequenceOf = (state: string, home: E2eHome): string => `${ESC}]2;${titleTextOf(state, home)}${ESC}\\`;

const startSession = async (home: E2eHome, env: Readonly<Record<string, string>>): Promise<PtySession> => {
  const pty = await spawnPty(home, [], env, { fakes: true });
  await answerTrust(pty, 'trust');
  await pty.waitFor({ shows: 'mode: manual', in: 'footer' });
  return pty;
};

const submit = async (pty: PtySession, text: string): Promise<void> => {
  await pty.type(text);
  await pty.key('enter', { until: { lacks: text, in: 'input' } });
};

const MARKER = 'zq';
const DELETE_KEY = '\u007f';

const reportAwayAndProveRead = async (pty: PtySession): Promise<void> => {
  await pty.reportFocus('out');
  await pty.type(MARKER);
  await pty.key(`${DELETE_KEY}${DELETE_KEY}` as KeyName, { until: { lacks: MARKER, in: 'input' } });
};

const submitWhileAway = async (pty: PtySession, fake: FakeChatCompletionsServer, text: string): Promise<void> => {
  const hold = fake.hold();
  await submit(pty, text);
  await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the model request of ${text}` });
  await reportAwayAndProveRead(pty);
  hold.release();
};

const untilDoneTitle = async (pty: PtySession, home: E2eHome, times: number): Promise<void> => {
  const done = titleSequenceOf('done', home);
  await until(async () => countOf(await pty.written(), done) >= times, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the product to set the done title ${times} time(s)` });
};

const awaitRunEnd = async (pty: PtySession, reply: string, home: E2eHome, times = 1): Promise<void> => {
  await pty.waitFor(reply);
  await untilRunEnds(pty, 'manual');
  await untilDoneTitle(pty, home, times);
};

const leave = async (pty: PtySession): Promise<string> => {
  await pty.key('ctrlD', { until: 'Press ctrl+d again to exit' });
  expect((await pty.key('ctrlD', { until: 'exit' })).status).toEqual({ code: 0, signal: null });
  return pty.written();
};

const expectNoSignal = (raw: string): void => {
  expect(countOf(raw, OSC9), escaped(raw)).toBe(0);
  expect(bellSignalsIn(raw), escaped(raw)).toBe(0);
};

describe('notify: attention signals through a pty', () => {
  it(titleOf('notify-pty-osc9'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, GHOSTTY);
    const atStart = await pty.written();
    expect(countOf(atStart, FOCUS_REPORTING_ON), escaped(atStart)).toBe(1);
    expect(countOf(atStart, FOCUS_REPORTING_OFF), escaped(atStart)).toBe(0);
    await submitWhileAway(pty, fake, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    expect(countOf(all, notificationOf('done', home)), escaped(all)).toBe(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
    expect(all.lastIndexOf(FOCUS_REPORTING_OFF), escaped(all)).toBeGreaterThan(all.indexOf(notificationOf('done', home)));
  });

  it(titleOf('notify-pty-bell'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, {});
    const atStart = await pty.written();
    expect(countOf(atStart, FOCUS_REPORTING_ON), escaped(atStart)).toBe(1);
    expect(bellSignalsIn(atStart), escaped(atStart)).toBe(0);
    await submitWhileAway(pty, fake, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    expect(bellSignalsIn(all), escaped(all)).toBe(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(0);
    expect(all.lastIndexOf(FOCUS_REPORTING_OFF), escaped(all)).toBeGreaterThan(all.indexOf(FOCUS_REPORTING_ON));
  });

  it(titleOf('notify-pty-no-report'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, GHOSTTY);
    await submit(pty, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    expect(countOf(all, titleSequenceOf('done', home)), escaped(all)).toBeGreaterThan(0);
    expectNoSignal(all);
  });

  it(titleOf('notify-pty-focus-back'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, GHOSTTY);
    await pty.reportFocus('out');
    await pty.reportFocus('in');
    await submit(pty, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    expect(countOf(all, titleSequenceOf('done', home)), escaped(all)).toBeGreaterThan(0);
    expectNoSignal(all);
  });

  it(titleOf('notify-pty-approval'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const target = path.join(fs.realpathSync.native(home.project), 'config.toml');
    fs.writeFileSync(target, 'greeting = "hello"\n');
    const fake = await startUpstream(home, {
      home,
      script: [
        toolCallReply('Read', { file_path: target }, 'call_read'),
        toolCallReply('Edit', { file_path: target, old_string: '"hello"', new_string: '"hello, momonga"' }, 'call_edit'),
        textReply('Edited the greeting.'),
      ],
    });
    writeSettingsFile(home, baseSettings(home, sandboxChoiceOf({ home }).kind));
    const pty = await startSession(home, GHOSTTY);
    await submitWhileAway(pty, fake, 'change the greeting');
    await pty.waitFor('Permission requested: Edit config.toml');
    await pty.waitForPrompt('+greeting = "hello, momonga"');
    const atApproval = await pty.written();
    expect(countOf(atApproval, notificationOf('waiting for you', home)), escaped(atApproval)).toBe(1);
    expect(countOf(atApproval, OSC9), escaped(atApproval)).toBe(1);
    await pty.reportFocus('in');
    await pty.key('1', { until: 'Edited the greeting.' });
    await untilRunEnds(pty, 'manual');
    await untilDoneTitle(pty, home, 1);
    const all = await leave(pty);
    expect(countOf(all, titleSequenceOf('done', home)), escaped(all)).toBeGreaterThan(0);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
  });

  it(titleOf('notify-pty-tmux'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, { ...GHOSTTY, TMUX: '/tmp/fake,1,0' });
    await submitWhileAway(pty, fake, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    const wrapped = `${ESC}Ptmux;${ESC}${notificationOf('done', home)}${ESC}\\`;
    expect(countOf(all, wrapped), escaped(all)).toBe(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all.replace(wrapped, '')), escaped(all)).toBe(0);
  });

  it(titleOf('notify-pty-late-focus'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('First finished.'), textReply('Second finished.')] });
    const pty = await startSession(home, GHOSTTY);
    await submit(pty, 'first task');
    await awaitRunEnd(pty, 'First finished.', home);
    await pty.reportFocus('out');
    await pty.type('second task');
    const whileAway = await pty.written();
    expect(countOf(whileAway, titleSequenceOf('done', home)), escaped(whileAway)).toBeGreaterThan(0);
    expectNoSignal(whileAway);
    await pty.reportFocus('in');
    const hold = fake.hold();
    await pty.key('enter', { until: { lacks: 'second task', in: 'input' } });
    await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the model request of the second task' });
    await reportAwayAndProveRead(pty);
    hold.release();
    await awaitRunEnd(pty, 'Second finished.', home, 2);
    const all = await leave(pty);
    expect(countOf(all, notificationOf('done', home)), escaped(all)).toBe(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
  });
});
