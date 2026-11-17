import { describe, expect, it, vi } from 'vitest';
import { parseSource } from './support/source-scan.ts';
import { countTimeSync, timeSyncOfTests } from './support/time-sync-scan.ts';
import type { TimeSyncKind } from './support/time-sync-scan.ts';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: SOURCE_SCAN_TEST_TIMEOUT_MS });

type Kept = { kinds: Partial<Record<TimeSyncKind, number>>; reason: string };

type BurnDown = { kinds: Partial<Record<TimeSyncKind, number>>; owner: string };

const KEPT: Readonly<Record<string, Kept>> = {
  'packages/cli/test/broken-pipe-entry.ts': { kinds: { 'timer wait': 1 }, reason: 'the flooding command gives the event loop a turn so that the broken pipe of its output is delivered while it still writes: the turn is the event the case needs' },
  'packages/eval/test/runner.test.ts': { kinds: { 'timer wait': 2 }, reason: 'node reports an unhandled rejection only after a macrotask: the turn is the event the case waits for' },
  'packages/foundation/test/file-pattern-linear.test.ts': { kinds: { 'timer wait': 1 }, reason: 'a backtracking matcher blocks its thread so no test timeout can fire: the bound that ends the worker running the pathological rule is the only way such a regression fails instead of holding the run' },
  'packages/foundation/test/outbound-trust-off-loop.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the fake worker spends a fixed span of CPU so the case can show it runs off the event loop' },
  'packages/foundation/test/path-asking.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the asking does not block the event loop: a turn that runs while the work is pending is the event' },
  'packages/foundation/test/path-resolver-async.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the resolution does not block the event loop: a timer that fires while the work is pending is the event' },
  'packages/foundation/test/support/secret-store-fakes.ts': { kinds: { 'timer wait': 1 }, reason: 'node reports an unhandled rejection only after a macrotask: rejectionsReported is that one turn, used only where the case shows a late settlement raises no unhandled rejection' },
  'packages/foundation/test/wait-until.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the subject is the one poll of the foundation; the macrotask is the step it is driven by' },
  'packages/gateway/test/upstream-content-idle.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 6 }, reason: 'the subject is the content-idle bound of the adapters against an upstream that keeps writing by the wall clock over a real socket' },
  'packages/mcp/test/output-pattern-off-thread.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the limit of the pattern check is a wall-clock bound of the product; the case measures that it holds' },
  'packages/memory/test/contribution-scripts.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the case measures that the scan of a long run without spaces is linear: its wall time is the property' },
  'packages/policy/test/decision-resolver.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the decision does not block the event loop: a timer that fires while the work is pending is the event' },
  'packages/runtime/test/calibration/offloop-cost.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'a calibration measures wall time by design and runs only in the calibration project' },
  'packages/runtime/test/gateway-client/real-gateway-liveness.test.ts': { kinds: { 'timer wait': 3 }, reason: 'the subject is a silence of the upstream longer than the idle bound of the real client, in real time behind a real gateway' },
  'packages/runtime/test/worker/search-index-cost.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the indexing does not block the event loop: a turn that runs while the work is pending is the event' },
  'packages/sandbox/test/bubblewrap-launch.test.ts': { kinds: { 'wall-clock reading': 2 }, reason: 'the subject is the kill grace of a real process group: SIGKILL may not come before it and a command that honours SIGTERM ends inside it' },
  'packages/sandbox/test/bubblewrap-real.test.ts': { kinds: { 'wall-clock reading': 2 }, reason: 'the subject is the kill grace of a real process group: SIGKILL may not come before it and a command that honours SIGTERM ends inside it' },
  'packages/sandbox/test/seatbelt.test.ts': { kinds: { 'wall-clock reading': 1 }, reason: 'the subject is the kill grace of a real process group: SIGKILL may not come before it' },
  'packages/store/test/search-incremental.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the case proves the indexing does not block the event loop: a turn that runs while the work is pending is the event' },
  'packages/supervisor/test/entry-slow-fs.test.ts': { kinds: { 'timer wait': 1 }, reason: 'the latency of the slow file system is real time by design: the case shows the pump of the harness waits for real I/O' },
  'packages/tools/test/builtins/review.test.ts': { kinds: { 'timer wait': 1 }, reason: 'a test-side bound on a host call that could otherwise block a thread forever: the FIFO case unblocks the pipe if the product ever opens it, because an open of a FIFO blocks a host thread with no event' },
  'packages/supervisor/test/p3-harness-pump.test.ts': { kinds: { 'timer wait': 2 }, reason: 'the subject is the pump of the harness against real timers and real I/O' },
  'test/no-time-sync.test.ts': { kinds: { 'holder that ends by itself': 2 }, reason: 'the two holder fixtures are the texts the scan itself is tested with' },
  'packages/testkit/test/drive-fake-time.test.ts': { kinds: { 'wall-clock reading': 3 }, reason: 'the subject is the fake-time driver; its real-time deadline is the property under test' },
  'packages/verify/test/support/dialect-model/gate.ts': { kinds: { 'wall-clock reading': 2 }, reason: 'the gate script of the dialect model prints the wall time its run took; nothing waits on the reading' },
  'packages/verify/test/support/dialect-model/harness.ts': { kinds: { 'wall-clock reading': 2 }, reason: 'the shrinking of a counterexample ends at a wall-clock budget; no assertion depends on where it ends' },
};

const BURN_DOWN: Readonly<Record<string, BurnDown>> = {
  'e2e/support/stack.ts': { kinds: { 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'e2e/support/wait.ts': { kinds: { 'timer wait': 2, 'wall-clock reading': 1 }, owner: 'tests-W7: C-e2e-bodies (wall-clock asserts) and C-waits (the e2e bounds list)' },
  'packages/foundation/test/platform/linux-real-processes.test.ts': { kinds: { 'timer wait': 1, 'wall-clock reading': 1 }, owner: 'the release gate, Linux container run: the agent must be older than the marker by a clock tick, and the probe that succeeds at once is measured on the wall clock because the Linux inspector takes no timing' },
  'packages/runtime/test/process/cancel-recovery.test.ts': { kinds: { 'holder that ends by itself': 2 }, owner: 'runtime: the holders run through the product sandbox, which ends them' },
  'packages/sandbox/test/after-exit-shared.test.ts': { kinds: { 'timer wait': 1 }, owner: 'sandbox: an exit that must stay pending while the cleanup after it runs shows no event; the case gives it twenty turns' },
  'packages/testkit/test/fake-chat-completions-hold.test.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W7 (fake-chat-completions): a held request is shown pending by twenty turns' },
  'packages/testkit/test/fake-chat-completions-routes.test.ts': { kinds: { 'timer wait': 2 }, owner: 'tests-W7 (fake-chat-completions): a held request is shown pending by twenty turns' },
  'test/formal/runner.ts': { kinds: { 'timer wait': 1 }, owner: 'tests-W11 (formal tier): the CPU budget poll of the TLC runner' },
  'test/formal/tlc.test.ts': { kinds: { 'wall-clock reading': 2, 'timer wait': 2 }, owner: 'tests-W11 (formal tier): the CPU budget against wall seconds is the subject' },
};

const FOUND = timeSyncOfTests();

const counted = (text: string, file = 'fixture.test.ts') => countTimeSync(parseSource(file, text));

const allowedOf = (file: string): Partial<Record<string, number>> => ({ ...KEPT[file]?.kinds, ...BURN_DOWN[file]?.kinds });

describe('no test synchronises on time: it waits on the event, the journal entry or the exit the product exposes', () => {
  it.each([
    ['a sleep on a real timer', 'await new Promise((resolve) => setTimeout(resolve, 20));', 'timer wait'],
    ['an event-loop turn', 'await new Promise<void>((resolve) => setImmediate(resolve));', 'timer wait'],
    ['a fixed number of turns', 'for (let turn = 0; turn < 10; turn += 1) await new Promise((r) => setImmediate(r));', 'timer wait'],
    ['a race against a real timer', "await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('late'), 2000))]);", 'timer wait'],
    ['a timer through globalThis', 'await new Promise((resolve) => globalThis.setTimeout(resolve, 5));', 'timer wait'],
    ['the promise timers of node', "import { setTimeout as delay } from 'node:timers/promises';\nawait delay(5);", 'timer wait'],
    ['the turn of node:timers/promises', "import { setImmediate as nextTurn } from 'node:timers/promises';\nawait nextTurn();", 'timer wait'],
    ['a wall-clock difference', 'const t0 = Date.now();\nawait work;\nexpect(Date.now() - t0).toBeLessThan(100);', 'wall-clock reading'],
    ['a wall-clock deadline', 'while (!done() && Date.now() < deadline) await step();', 'wall-clock reading'],
    ['a monotonic difference', 'expect(performance.now() - started).toBeLessThan(10);', 'wall-clock reading'],
    ['a host timer vitest leaves real beside its faked timeouts', "vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });\nawait new Promise((resolve) => setImmediate(resolve));", 'timer wait'],
    ['the promise timers of node beside the faked host timers', "import { setImmediate as nextTurn } from 'node:timers/promises';\nvi.useFakeTimers();\nawait nextTurn();", 'timer wait'],
    ['a wall-clock comparison vitest leaves real beside its faked timeouts', "vi.useFakeTimers({ toFake: ['setTimeout'] });\nexpect(Date.now() - t0).toBeLessThan(100);", 'wall-clock reading'],
    ['a host timer of a helper beside timers faked in one case only', "const sleep = () => new Promise((resolve) => setTimeout(resolve, 40));\nit('fakes', () => { vi.useFakeTimers(); });", 'timer wait'],
    ['a holder that ends by itself beside a fake clock', "const clock = createFakeClock(0);\nspawn('/bin/sh', ['-c', 'exec /bin/sleep 30']);", 'holder that ends by itself'],
  ])('refuses %s', (_form, text, kind) => {
    expect(counted(text)).toEqual({ [kind]: 1 });
  });

  it.each([
    ['a fake timer resolving a promise', 'await new Promise((resolve) => timers.setTimeout(resolve, 20));'],
    ['an asynchronous emit of a fake', "setImmediate(() => child.emit('error', failure));"],
    ['a timer of a destructured fake', 'const { setTimeout } = createFakeTimers(clock);\nawait new Promise((resolve) => setTimeout(resolve, 5));'],
    ['a reading of the wall clock that is not compared', 'const clock = createFakeClock(Date.now());'],
    ['a holder that waits for its signal', "spawn('/bin/sh', ['-c', 'exec /usr/bin/tail -f /dev/null']);"],
    ['a sleep in a script beside no fake clock', "spawn('/bin/sh', ['-c', 'exec /bin/sleep 30']);"],
    ['a timer of the faked host timers of vitest', 'vi.useFakeTimers();\nawait new Promise((resolve) => setTimeout(resolve, 5));'],
    ['a timer vitest fakes by name', "vi.useFakeTimers({ toFake: ['setImmediate'] });\nawait new Promise((resolve) => setImmediate(resolve));"],
    ['a timer inside the case that fakes it', "it('waits', async () => { vi.useFakeTimers(); await new Promise((resolve) => setTimeout(resolve, 5)); });"],
    ['a timer of a helper beside timers faked for every case', "beforeEach(() => { vi.useFakeTimers(); });\nconst sleep = () => new Promise((resolve) => setTimeout(resolve, 40));"],
    ['the forbidden forms in a string', "const fixture = 'await new Promise((resolve) => setTimeout(resolve, 5)); Date.now() - t0';"],
  ])('accepts %s', (_form, text) => {
    expect(counted(text)).toEqual({});
  });

  it('finds no form beyond the kept sites and the burn-down', () => {
    const found = FOUND;
    const over = Object.entries(found).flatMap(([file, counts]) =>
      Object.entries(counts)
        .filter(([kind, count]) => count > (allowedOf(file)[kind] ?? 0))
        .map(([kind, count]) => `${file}: ${count} ${kind}, ${allowedOf(file)[kind] ?? 0} allowed`),
    );
    expect(over).toEqual([]);
  });

  it('keeps no allowance for a site that is gone, so the lists only shrink', () => {
    const found = FOUND;
    const stale = [...new Set([...Object.keys(KEPT), ...Object.keys(BURN_DOWN)])].flatMap((file) =>
      Object.entries(allowedOf(file))
        .filter(([kind, count]) => (count ?? 0) > (found[file]?.[kind] ?? 0))
        .map(([kind, count]) => `${file}: ${count} ${kind} allowed, ${found[file]?.[kind] ?? 0} found`),
    );
    expect(stale).toEqual([]);
  });

  it('lists a file in one table only', () => {
    expect(Object.keys(KEPT).filter((file) => file in BURN_DOWN)).toEqual([]);
  });
});
