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
const TITLE_PUSH = `${ESC}[22;2t`;
const TITLE_POP = `${ESC}[23;2t`;
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

const TITLE_START = `${ESC}]2;`;
const TITLE_END = `${ESC}\\`;

const plainTitleOf = (home: E2eHome): string => `${TITLE_START}${folderOf(home)} - momonga${TITLE_END}`;

const actionTitleOf = (home: E2eHome): string => `${TITLE_START}[ ! ] Action Required - ${folderOf(home)} - momonga${TITLE_END}`;

const titlesIn = (raw: string): string[] => splitOscs(raw).oscs.filter((osc) => osc.startsWith(TITLE_START));

const literalPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const doneNotificationPattern = (home: E2eHome): string => `${literalPattern(OSC9)}Run complete in \\d+s - ${literalPattern(folderOf(home))}${literalPattern(BEL)}`;

const isSpinnerTitle = (title: string | undefined, home: E2eHome): boolean => title !== undefined && new RegExp(`^${literalPattern(TITLE_START)}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${literalPattern(folderOf(home))} - momonga${literalPattern(TITLE_END)}$`).test(title);

const runEndTitlesIn = (raw: string, home: E2eHome): number => {
  const titles = titlesIn(raw);
  return titles.filter((title, index) => title === plainTitleOf(home) && isSpinnerTitle(titles[index - 1], home)).length;
};

const titlesBefore = (raw: string, needle: string): string[] => titlesIn(raw.slice(0, raw.indexOf(needle)));

const doneNotificationsIn = (raw: string, home: E2eHome): string[] => raw.match(new RegExp(doneNotificationPattern(home), 'g')) ?? [];

const tmuxDoneNotificationsIn = (raw: string, home: E2eHome): string[] => raw.match(new RegExp(`${literalPattern(`${ESC}Ptmux;${ESC}`)}${doneNotificationPattern(home)}${literalPattern(`${ESC}\\`)}`, 'g')) ?? [];

const approvalNotificationOf = (home: E2eHome): string => `${OSC9}Permission requested: Edit config.toml - ${folderOf(home)}${BEL}`;

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

const untilSpinnerTitle = async (pty: PtySession, home: E2eHome): Promise<void> => {
  await until(async () => titlesIn(await pty.written()).some((title) => isSpinnerTitle(title, home)), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the product to set a spinner title while the model holds its reply' });
};

const submitWhileAway = async (pty: PtySession, fake: FakeChatCompletionsServer, text: string, home: E2eHome): Promise<void> => {
  const hold = fake.hold();
  await submit(pty, text);
  await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the model request of ${text}` });
  await untilSpinnerTitle(pty, home);
  await reportAwayAndProveRead(pty);
  hold.release();
};

const untilDoneTitle = async (pty: PtySession, home: E2eHome, times: number): Promise<void> => {
  await until(async () => runEndTitlesIn(await pty.written(), home) >= times, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `the product to set the plain title after a spinner ${times} time(s)` });
};

const untilSignals = async (pty: PtySession, times: number): Promise<void> => {
  await until(async () => {
    const raw = await pty.written();
    return countOf(raw, OSC9) + bellSignalsIn(raw) >= times;
  }, { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description: `${times} signal(s) after the title` });
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

const expectNoTitleAfterLastPop = (raw: string): void => {
  const lastPop = raw.lastIndexOf(TITLE_POP);
  expect(lastPop, escaped(raw)).toBeGreaterThan(-1);
  const after = raw.slice(lastPop + TITLE_POP.length);
  expect(after.includes(TITLE_START), escaped(after)).toBe(false);
  expect(after.includes(TITLE_PUSH), escaped(after)).toBe(false);
  expect(countOf(raw, TITLE_POP), escaped(raw)).toBe(countOf(raw, TITLE_PUSH));
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
    await submitWhileAway(pty, fake, 'finish the work', home);
    await awaitRunEnd(pty, 'All finished.', home);
    await untilSignals(pty, 1);
    const all = await leave(pty);
    const done = doneNotificationsIn(all, home);
    expect(done, escaped(all)).toHaveLength(1);
    const beforeDone = titlesBefore(all, done[0] ?? OSC9);
    expect(beforeDone.at(-1), escaped(all)).toBe(plainTitleOf(home));
    expect(isSpinnerTitle(beforeDone.at(-2), home), escaped(all)).toBe(true);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
    expect(all.lastIndexOf(FOCUS_REPORTING_OFF), escaped(all)).toBeGreaterThan(all.indexOf(done[0] ?? OSC9));
  });

  it(titleOf('notify-pty-bell'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, {});
    const atStart = await pty.written();
    expect(countOf(atStart, FOCUS_REPORTING_ON), escaped(atStart)).toBe(1);
    expect(bellSignalsIn(atStart), escaped(atStart)).toBe(0);
    await submitWhileAway(pty, fake, 'finish the work', home);
    await awaitRunEnd(pty, 'All finished.', home);
    await untilSignals(pty, 1);
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
    expect(runEndTitlesIn(all, home), escaped(all)).toBeGreaterThan(0);
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
    expect(runEndTitlesIn(all, home), escaped(all)).toBeGreaterThan(0);
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
    await submitWhileAway(pty, fake, 'change the greeting', home);
    await pty.waitFor('Permission requested: Edit config.toml');
    await pty.waitForPrompt('+greeting = "hello, momonga"');
    await untilSignals(pty, 1);
    const atApproval = await pty.written();
    expect(countOf(atApproval, approvalNotificationOf(home)), escaped(atApproval)).toBe(1);
    expect(countOf(atApproval, OSC9), escaped(atApproval)).toBe(1);
    const beforeApproval = titlesBefore(atApproval, approvalNotificationOf(home));
    expect(beforeApproval.at(-1), escaped(atApproval)).toBe(actionTitleOf(home));
    expect(beforeApproval.findLastIndex((title) => isSpinnerTitle(title, home)), escaped(atApproval)).toBeGreaterThan(-1);
    await pty.reportFocus('in');
    await pty.key('1', { until: 'Edited the greeting.' });
    await untilRunEnds(pty, 'manual');
    await untilDoneTitle(pty, home, 1);
    const all = await leave(pty);
    expect(runEndTitlesIn(all, home), escaped(all)).toBeGreaterThan(0);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
  });

  it(titleOf('notify-pty-tmux'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, { ...GHOSTTY, TMUX: '/tmp/fake,1,0' });
    await submitWhileAway(pty, fake, 'finish the work', home);
    await awaitRunEnd(pty, 'All finished.', home);
    await untilSignals(pty, 1);
    const all = await leave(pty);
    const wrapped = tmuxDoneNotificationsIn(all, home);
    expect(wrapped, escaped(all)).toHaveLength(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all.replace(wrapped[0] ?? '', '')), escaped(all)).toBe(0);
  });

  it(titleOf('notify-pty-late-focus'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('First finished.'), textReply('Second finished.')] });
    const pty = await startSession(home, GHOSTTY);
    await submit(pty, 'first task');
    await awaitRunEnd(pty, 'First finished.', home);
    await pty.reportFocus('out');
    await pty.type('second task');
    const whileAway = await pty.written();
    expect(runEndTitlesIn(whileAway, home), escaped(whileAway)).toBeGreaterThan(0);
    expectNoSignal(whileAway);
    await pty.reportFocus('in');
    const hold = fake.hold();
    await pty.key('enter', { until: { lacks: 'second task', in: 'input' } });
    await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the model request of the second task' });
    await untilSpinnerTitle(pty, home);
    await reportAwayAndProveRead(pty);
    hold.release();
    await awaitRunEnd(pty, 'Second finished.', home, 2);
    await untilSignals(pty, 1);
    const all = await leave(pty);
    expect(doneNotificationsIn(all, home), escaped(all)).toHaveLength(1);
    expect(countOf(all, OSC9), escaped(all)).toBe(1);
    expect(bellSignalsIn(all), escaped(all)).toBe(0);
  });

  it(titleOf('notify-pty-exit-idle-title'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, GHOSTTY);
    await submit(pty, 'finish the work');
    await awaitRunEnd(pty, 'All finished.', home);
    const all = await leave(pty);
    expectNoTitleAfterLastPop(all);
  });

  it(titleOf('notify-pty-exit-working-title'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const { home, fake } = await prepareProduct({ script: [textReply('All finished.')] });
    const pty = await startSession(home, GHOSTTY);
    const hold = fake.hold();
    await submit(pty, 'finish the work');
    await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the model request of the held run' });
    await untilSpinnerTitle(pty, home);
    try {
      const all = await leave(pty);
      expectNoTitleAfterLastPop(all);
    } finally {
      hold.release();
    }
  });
});
