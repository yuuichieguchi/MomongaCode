import { describe, expect, it, vi } from 'vitest';
import { listedEntryOf, runView } from '../fake-backend.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { highlighted, hold, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming } from './keys-shown-screen.tsx';
import { EFFORT_PICKER, MODEL_LIST, SIGNED_IN, toRow, transitions } from './keys-shown-screen-cases.tsx';
import type { Transition } from './keys-shown-screen-cases.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const USAGE_LIMIT = runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });
const LIMIT_LIST = (frame: string): boolean => frame.includes('Manage usage') && frame.includes('Dismiss');
const DISMISS = '2';
const LIMIT_LINE = 'Usage limit reached';
const NOT_CURRENT = /the list of models is not current: \S/;
const LUNA_ROW = 'gpt-6-luna';
const NO_ANSWER_LINE = 'the list of models is not current: no answer within 15 seconds';

const transitionOf = (step: string): Transition => {
  const found = transitions.find((candidate) => candidate.step === step);
  if (found === undefined) throw new Error(`no transition ${step}`);
  return found;
};

const working = async (transition?: Transition): Promise<AtRealTiming> => {
  const driver = await startAtRealTiming(transition === undefined ? SIGNED_IN : await transition.given());
  await driver.submit('long task');
  await driver.until(() => driver.backend.started.length === 1, 'the run started');
  await driver.settled();
  return driver;
};

const limitAnswered = async (driver: AtRealTiming): Promise<void> => {
  driver.backend.finish(USAGE_LIMIT);
  await driver.untilShown(LIMIT_LIST);
  driver.app.stdin.write(DISMISS);
  await driver.pause(300);
  expect(LIMIT_LIST(driver.frameNow())).toBe(false);
};

describe('a run that ends on the usage limit while a screen is open: the usage-limit list comes on top, and once answered the screen underneath is back', () => {
  it('(a) a list: the list returns with the same row highlighted', async () => {
    const driver = await working();
    await driver.submit('/mode');
    await driver.untilShown(highlighted('manual'));
    await driver.settled();
    driver.backend.finish(USAGE_LIMIT);
    await driver.untilShown(LIMIT_LIST);
    expect(driver.frameNow()).not.toContain('Permission mode');
    driver.app.stdin.write(DISMISS);
    await driver.pause(300);
    expect(LIMIT_LIST(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).toContain('Permission mode');
    expect(highlighted('manual')(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('(b) a text field with typed text: the field returns with the typed text', async () => {
    const transition = transitionOf('Type the address of a model server → the address field');
    const driver = await working(transition);
    await transition.reach(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(transition.next);
    driver.app.stdin.write('http://10.0.0.7');
    await driver.untilShown('http://10.0.0.7');
    await limitAnswered(driver);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    expect(driver.frameNow()).toContain('http://10.0.0.7');
    driver.app.unmount();
  });

  it('(c) the key capture: the capture screen returns', async () => {
    const transition = transitionOf('an action row → the key capture');
    const driver = await working(transition);
    await transition.reach(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(transition.next);
    await limitAnswered(driver);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('(d) a wait screen after a choice: the wait screen returns, then the next screen when the wait ends', async () => {
    const transition = transitionOf('Model settings… → the models hub, its listing read later');
    const driver = await working(transition);
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    const [title, phase] = transition.waitScreen ?? ['', ''];
    await driver.untilShown((frame) => frame.includes(title) && frame.includes(phase));
    await limitAnswered(driver);
    expect(driver.frameNow()).toContain(phase);
    held?.release();
    await driver.untilShown(transition.next);
    driver.app.unmount();
  });

  it('(d) a wait screen that ended while the usage-limit list showed: the next screen the flow reached is shown', async () => {
    const transition = transitionOf('Model settings… → the models hub, its listing read later');
    const driver = await working(transition);
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    const [title, phase] = transition.waitScreen ?? ['', ''];
    await driver.untilShown((frame) => frame.includes(title) && frame.includes(phase));
    driver.backend.finish(USAGE_LIMIT);
    await driver.untilShown(LIMIT_LIST);
    held?.release();
    await driver.pause(300);
    expect(LIMIT_LIST(driver.frameNow())).toBe(true);
    driver.app.stdin.write(DISMISS);
    await driver.pause(300);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('(e) nothing open: the list shows, and once answered the prompt is back', async () => {
    const driver = await working();
    await limitAnswered(driver);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    driver.app.unmount();
  });

  it('a key pressed 0 ms after the usage-limit list is drawn answers it', async () => {
    const driver = await working();
    driver.backend.finish(USAGE_LIMIT);
    await driver.untilShown(LIMIT_LIST);
    driver.app.stdin.write(DISMISS);
    await driver.pause(50);
    expect(LIMIT_LIST(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).toContain(LIMIT_LINE);
    driver.app.unmount();
  });

  it('enter pressed before the usage-limit list is drawn does not answer it', async () => {
    const driver = await working();
    driver.app.stdin.write(KEYS.enter);
    driver.backend.finish(USAGE_LIMIT);
    await driver.untilShown(LIMIT_LIST);
    await driver.pause(300);
    expect(LIMIT_LIST(driver.frameNow())).toBe(true);
    expect(driver.backend.openedUrls).toEqual([]);
    driver.app.unmount();
  });
});

type Gate = { release(): void; fail(error: Error): void; calls(): number };

const gateListing = (driver: AtRealTiming, added?: string): Gate => {
  const original = driver.backend.modelList.bind(driver.backend);
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  driver.backend.modelList = async () => {
    calls += 1;
    await gate.promise;
    const listed = await original();
    const first = listed.data[0];
    const member = first?.chain[0];
    return added === undefined || first === undefined || member === undefined ? listed : { ...listed, data: [...listed.data, { ...listedEntryOf(added, member.capabilities), billing: first.billing, capabilities: first.capabilities }] };
  };
  return { release: () => gate.resolve(), fail: (error) => gate.reject(error), calls: () => calls };
};

const effortOpen = async (): Promise<AtRealTiming> => {
  const driver = await startAtRealTiming(SIGNED_IN);
  await driver.submit('/model');
  await driver.untilShown(MODEL_LIST);
  await driver.settled();
  await toRow(driver, LUNA_ROW);
  driver.app.stdin.write(KEYS.enter);
  await driver.untilShown(EFFORT_PICKER);
  await driver.settled();
  return driver;
};

const listAtOnce = async (driver: AtRealTiming): Promise<void> => {
  const since = driver.mark();
  driver.app.stdin.write(KEYS.escape);
  await driver.pause(20);
  expect(shows(MODEL_LIST)(driver.frameNow())).toBe(true);
  expect(highlighted(LUNA_ROW)(driver.frameNow())).toBe(true);
  expect(since().filter((frame) => frame.includes('Loading models…') || frame.includes('reading…'))).toEqual([]);
};

describe('/model: esc back to the model list shows the list at once and reads it again behind it', () => {
  it('esc on the effort screen: the list with the chosen row highlighted at once, no wait screen', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    expect(reread.calls()).toBeGreaterThan(0);
    reread.release();
    driver.app.unmount();
  });

  it('esc during Loading models…: the list with the chosen row highlighted at once', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, LUNA_ROW);
    const loading = hold(driver.backend, 'models');
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown('Loading models…');
    const reread = gateListing(driver);
    await listAtOnce(driver);
    loading.release();
    reread.release();
    driver.app.unmount();
  });

  it('enter during the re-read chooses the shown row', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(300);
    expect(EFFORT_PICKER(driver.frameNow())).toBe(true);
    reread.release();
    driver.app.unmount();
  });

  it('esc during the re-read closes the list', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(false);
    reread.release();
    await driver.pause(300);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(false);
    driver.app.unmount();
  });

  it('when the re-read ends the rows are replaced and the highlighted model is the same', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver, 'ollama/added-model:latest');
    await listAtOnce(driver);
    expect(driver.frameNow()).not.toContain('added-model');
    reread.release();
    await driver.untilShown('added-model');
    expect(highlighted(LUNA_ROW)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });
});

describe('the re-read of the model list fails or gets no answer', () => {
  it('fails while the list shows: the rows stay selectable and the list has the line that it is not current', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    reread.fail(new Error('the gateway refused the connection'));
    await driver.pause(300);
    expect(NOT_CURRENT.test(driver.frameNow())).toBe(true);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(true);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(300);
    expect(EFFORT_PICKER(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('no answer for 15 seconds: the line says no answer within 15 seconds, and not before', async () => {
    const driver = await effortOpen();
    gateListing(driver);
    await listAtOnce(driver);
    await driver.pause(14_900);
    expect(driver.frameNow()).not.toContain(NO_ANSWER_LINE);
    expect(NOT_CURRENT.test(driver.frameNow())).toBe(false);
    await driver.pause(200);
    expect(driver.frameNow()).toContain(NO_ANSWER_LINE);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('fails after a row was chosen: nothing is shown', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(EFFORT_PICKER);
    reread.fail(new Error('the gateway refused the connection'));
    await driver.pause(300);
    expect(driver.app.frames.some((frame) => frame.includes('not current'))).toBe(false);
    expect(EFFORT_PICKER(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('fails after the list was closed: nothing is shown', async () => {
    const driver = await effortOpen();
    const reread = gateListing(driver);
    await listAtOnce(driver);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
    reread.fail(new Error('the gateway refused the connection'));
    await driver.pause(300);
    expect(driver.app.frames.some((frame) => frame.includes('not current'))).toBe(false);
    driver.app.unmount();
  });

  it('one account cannot be read: the line names the account and the reason', async () => {
    const driver = await startAtRealTiming({ ...SIGNED_IN, catalogFailures: { chatgpt: new Error('the account server did not answer') } });
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.pause(300);
    expect(driver.frameNow()).toContain('the list of models of chatgpt is not current: the account server did not answer');
    driver.app.unmount();
  });
});

describe('a step left with esc whose answer arrives later changes nothing', () => {
  const HUB_STEP = 'Model settings… → the models hub, its listing read later';

  it('(a) the answer arrives after the list is shown again: the list stays, its row highlighted', async () => {
    const transition = transitionOf(HUB_STEP);
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => shows(transition.previous)(frame) && highlighted(transition.row)(frame));
    held?.release();
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(false);
    expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('(b) the answer arrives while another row was chosen and its step waits: the newer step is not completed by it', async () => {
    const transition = transitionOf(HUB_STEP);
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => shows(transition.previous)(frame) && highlighted(transition.row)(frame));
    await driver.settled();
    await toRow(driver, LUNA_ROW);
    const loading = hold(driver.backend, 'models');
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown('Loading models…');
    held?.release();
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).toContain('Loading models…');
    loading.release();
    await driver.untilShown(EFFORT_PICKER);
    driver.app.unmount();
  });

  it('(c) the answer arrives after the list was closed: nothing is shown', async () => {
    const transition = transitionOf(HUB_STEP);
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => shows(transition.previous)(frame) && highlighted(transition.row)(frame));
    await driver.settled();
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => !shows(transition.previous)(frame));
    held?.release();
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(false);
    expect(shows(transition.previous)(driver.frameNow())).toBe(false);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    driver.app.unmount();
  });
});

const NOT_ELIGIBLE_MESSAGE = 'This account is not eligible for plan use.';
const NOT_ELIGIBLE = (id: string) => runView({ id, status: 'FAILED', error: { code: 'plan_not_eligible', message: NOT_ELIGIBLE_MESSAGE, plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });
const LIMIT_END = (id: string) => runView({ id, status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });
const BLOCK_LIST = (frame: string): boolean => frame.includes('Use another account') && frame.includes('Dismiss');
const BLOCK_DISMISS = '3';
const timesShown = (frame: string, line: string): number => frame.split(line).length - 1;

const queuedBehind = async (driver: AtRealTiming): Promise<void> => {
  driver.app.stdin.write('second task');
  await driver.untilShown('> second task');
  driver.app.stdin.write(KEYS.tab);
  await driver.until(() => driver.backend.calls.includes('inbox:queue:second task'), 'the prompt queued');
  driver.backend.deliverInbox('row-1');
  driver.backend.succeed('run-1', runView({ id: 'run-2', ordinal: 2, status: 'QUEUED', previousRunId: 'run-1' }));
};

const firstEnded = async (driver: AtRealTiming, end: ReturnType<typeof runView>, list: (frame: string) => boolean): Promise<void> => {
  driver.backend.finish(end);
  await driver.untilShown(list);
  await driver.until(() => driver.backend.followed.includes('run-2'), 'the queued run followed');
  await driver.settled();
};

describe('a second run end on a limit while the list of the first shows', () => {
  it('a second usage-limit end: no second list, the first list and its highlighted row unchanged, the limit line printed again, one answer closes it', async () => {
    const driver = await working();
    await queuedBehind(driver);
    await firstEnded(driver, LIMIT_END('run-1'), LIMIT_LIST);
    driver.app.stdin.write(KEYS.down);
    await driver.untilShown(highlighted('Dismiss'));
    await driver.settled();
    driver.backend.finish(LIMIT_END('run-2'));
    await driver.pause(500);
    expect(LIMIT_LIST(driver.frameNow())).toBe(true);
    expect(highlighted('Dismiss')(driver.frameNow())).toBe(true);
    expect(timesShown(driver.frameNow(), LIMIT_LINE)).toBe(2);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(500);
    expect(LIMIT_LIST(driver.frameNow())).toBe(false);
    driver.app.unmount();
  });

  it('a second plan-block end: no second list, the first list and its highlighted row unchanged, the line printed again, one answer closes it', async () => {
    const driver = await working();
    await queuedBehind(driver);
    await firstEnded(driver, NOT_ELIGIBLE('run-1'), BLOCK_LIST);
    driver.app.stdin.write(KEYS.down);
    await driver.untilShown(highlighted('Use an API key'));
    await driver.settled();
    driver.backend.finish(NOT_ELIGIBLE('run-2'));
    await driver.pause(500);
    expect(BLOCK_LIST(driver.frameNow())).toBe(true);
    expect(highlighted('Use an API key')(driver.frameNow())).toBe(true);
    expect(timesShown(driver.frameNow(), NOT_ELIGIBLE_MESSAGE)).toBe(2);
    driver.app.stdin.write(BLOCK_DISMISS);
    await driver.pause(500);
    expect(BLOCK_LIST(driver.frameNow())).toBe(false);
    driver.app.unmount();
  });

  it('a plan-block end while the usage-limit list shows: the plan-block list on top, once answered the usage-limit list again, and an enter right after that takes its row', async () => {
    const driver = await working();
    await queuedBehind(driver);
    await firstEnded(driver, LIMIT_END('run-1'), LIMIT_LIST);
    driver.backend.finish(NOT_ELIGIBLE('run-2'));
    await driver.untilShown(BLOCK_LIST);
    expect(LIMIT_LIST(driver.frameNow())).toBe(false);
    await driver.settled();
    driver.app.stdin.write(BLOCK_DISMISS);
    await driver.untilShown((frame) => LIMIT_LIST(frame) && !BLOCK_LIST(frame));
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(300);
    expect(driver.backend.openedUrls).toHaveLength(1);
    driver.app.unmount();
  });
});
