import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, firstGeneration, decodeOtlpSpans, startOtlpCollector } from '@momonga/testkit';
import { onCleanup, writeInvalidUserSettings } from './helpers.ts';
import { finishApprovingPrompts, launchRuntime, prepareStack, scriptedToolCall, startGateway, startStack, waitForCondition, waitForStatus } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const FINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
const HOST_KIND = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap';
const OTHER_KIND = process.platform === 'darwin' ? 'bubblewrap' : 'seatbelt';
const OTHER_PLATFORM = process.platform === 'darwin' ? 'linux' : 'darwin';
const BYPASS = { permissionMode: 'bypassPermissions', bypassAllowed: true };

const textReply = (text: string) => ({ kind: 'stream' as const, chunks: [{ delta: { role: 'assistant', content: text }, finishReason: 'stop' }] });

const waitThenTouch = (go: string, started: string, target: string, done = `${started}.done`): string => `touch ${started}; while [ ! -e ${go} ]; do sleep 0.05; done; touch ${target}; touch ${done}`;

describe('S3 runtime sandbox: each tool batch pins the sandbox it started with (design-settings-live 3.2)', () => {
  it('a batch started under the host sandbox keeps it after the setting changes to none; the next batch runs under none', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack((temp) => ({
      script: [
        scriptedToolCall('Bash', { command: waitThenTouch(path.join(temp.root, 'go'), path.join(temp.project, 'started'), path.join(temp.root, 'outside-1')) }),
        textReply('first done'),
        scriptedToolCall('Bash', { command: `touch ${path.join(temp.root, 'outside-2')}` }, 'call_2'),
      ],
    }));
    stack.settings({ sandbox: HOST_KIND });
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession(BYPASS);
    const first = await launched.createRun(session.id, { input: 'first' });
    await waitForCondition(() => fs.existsSync(path.join(stack.temp.project, 'started')), 'the first batch to start under the host sandbox');
    stack.settings({ sandbox: 'none' });
    fs.writeFileSync(path.join(stack.temp.root, 'go'), '');
    expect(await waitForStatus(stack.temp, first.id, FINAL)).toBe('COMPLETED');
    expect(fs.existsSync(path.join(stack.temp.root, 'outside-1'))).toBe(false);
    const second = await launched.createRun(session.id, { input: 'second' });
    expect(await finishApprovingPrompts(launched, stack.temp, second.id)).toBe('COMPLETED');
    expect(fs.existsSync(path.join(stack.temp.root, 'outside-2'))).toBe(true);
  });

  it('a background job started under the host sandbox keeps it after the setting changes to none, while the next batch runs under none', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack((temp) => ({
      script: [
        scriptedToolCall('Bash', { command: waitThenTouch(path.join(temp.root, 'go'), path.join(temp.project, 'job-started'), path.join(temp.root, 'outside-job')), run_in_background: true }),
        textReply('job started'),
        scriptedToolCall('Bash', { command: `touch ${path.join(temp.root, 'outside-2')}` }, 'call_2'),
      ],
    }));
    stack.settings({ sandbox: HOST_KIND });
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession(BYPASS);
    const first = await launched.createRun(session.id, { input: 'start a job' });
    expect(await waitForStatus(stack.temp, first.id, FINAL)).toBe('COMPLETED');
    await waitForCondition(() => fs.existsSync(path.join(stack.temp.project, 'job-started')), 'the background job to start');
    stack.settings({ sandbox: 'none' });
    const second = await launched.createRun(session.id, { input: 'second' });
    expect(await finishApprovingPrompts(launched, stack.temp, second.id)).toBe('COMPLETED');
    expect(fs.existsSync(path.join(stack.temp.root, 'outside-2'))).toBe(true);
    fs.writeFileSync(path.join(stack.temp.root, 'go'), '');
    await waitForCondition(() => fs.existsSync(path.join(stack.temp.project, 'job-started.done')), 'the background job to end');
    expect(fs.existsSync(path.join(stack.temp.root, 'outside-job'))).toBe(false);
  });

  it('health.sandbox alone, with no session or tool call before it, shows the kind set by a change', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: 'none' });
    stack.settings({ sandbox: HOST_KIND });
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: HOST_KIND });
  });

  it('health.sandbox shows the kind of the object the next batch takes', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: 'none' });
    stack.settings({ sandbox: HOST_KIND });
    await launched.createSession();
    expect((await launched.http('GET', '/v1/health')).json).toMatchObject({ sandbox: HOST_KIND });
  });

  it('a sandbox kind this host cannot run: admission refuses with the exact text and the R22-Q15 suffix, and the running run completes on the last good sandbox', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const hold = stack.hold();
    const session = await launched.createSession();
    const running = await launched.createRun(session.id);
    await hold.waitForRequest();
    stack.settings({ sandbox: OTHER_KIND });
    const refused = await launched.http('POST', `/v1/sessions/${session.id}/runs`, { body: { input: 'hello' } });
    const settingsFile = path.join(stack.temp.home, '.momonga', 'settings.json');
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatchObject({
      code: 'config_error',
      message: `sandbox "${OTHER_KIND}" is only available on ${OTHER_PLATFORM}; set "sandbox" in ${settingsFile} to "none" to run without a sandbox (Bash will then ask before every command); new runs are refused until the file is fixed, running runs continue`,
    });
    hold.release();
    expect(await waitForStatus(stack.temp, running.id, FINAL)).toBe('COMPLETED');
  });
});

describe('S2 runtime telemetry: a span ends on the provider it started on (design-settings-live 3.3)', () => {
  it('a run that starts after a telemetry change is exported by the new provider', PROCESS_TIMEOUT, async () => {
    const before = await startOtlpCollector();
    onCleanup(() => before.close());
    const after = await startOtlpCollector();
    onCleanup(() => after.close());
    const stack = await startStack({}, { telemetry: { otlp: { endpoint: before.endpoint } } });
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const first = await launched.createRun(session.id, { input: 'first' });
    expect(await waitForStatus(stack.temp, first.id, FINAL)).toBe('COMPLETED');
    stack.settings({ telemetry: { otlp: { endpoint: after.endpoint } } });
    const second = await launched.createRun(session.id, { input: 'second' });
    expect(await waitForStatus(stack.temp, second.id, FINAL)).toBe('COMPLETED');
    await launched.handle.close();
    const runtimeSpans = (collector: typeof before) => decodeOtlpSpans(collector.requests).filter((span) => span.service.includes('runtime'));
    expect(decodeOtlpSpans(before.requests).map((span) => span.service)).toContain('momonga-runtime');
    expect(runtimeSpans(after).length, 'runtime spans exported to the endpoint set after the change').toBeGreaterThan(0);
  });
});

describe('S7 no rollback after apply: a tightened sandbox survives a broken file (design-settings-live 15.1, NoRollbackAfterApply)', () => {
  it('c tightened and not yet recorded, the file breaks during a run, the next Bash call runs under c', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack((temp) => ({ script: [scriptedToolCall('Bash', { command: `touch ${path.join(temp.root, 'outside-after-break')}` })] }));
    const record = firstGeneration(stack.temp.paths).settingsApplied;
    fs.mkdirSync(path.dirname(record), { recursive: true, mode: 0o700 });
    stack.settings();
    fs.writeFileSync(record, `${JSON.stringify({ seq: 1, settings: JSON.parse(fs.readFileSync(path.join(stack.temp.home, '.momonga', 'settings.json'), 'utf8')) })}\n`, { mode: 0o600 });
    const previous = process.env['MOMONGA_SETTINGS_APPLIED'];
    process.env['MOMONGA_SETTINGS_APPLIED'] = record;
    onCleanup(() => {
      if (previous === undefined) delete process.env['MOMONGA_SETTINGS_APPLIED'];
      else process.env['MOMONGA_SETTINGS_APPLIED'] = previous;
    });
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    stack.settings({ sandbox: HOST_KIND });
    const hold = stack.hold();
    const session = await launched.createSession(BYPASS);
    const run = await launched.createRun(session.id, { input: 'touch outside' });
    await hold.waitForRequest();
    writeInvalidUserSettings(stack.temp.home);
    hold.release();
    expect(await finishApprovingPrompts(launched, stack.temp, run.id)).toBe('COMPLETED');
    expect(fs.existsSync(path.join(stack.temp.root, 'outside-after-break')), 'the Bash call after the break ran under the tightened sandbox').toBe(false);
  });
});

describe('S2 runtime telemetry: the tracer lease is held for the agent span of a run (design-settings-live 15.6)', () => {
  it('a running run keeps its child spans on the old provider; the next run goes to the new one', PROCESS_TIMEOUT, async () => {
    const before = await startOtlpCollector();
    onCleanup(() => before.close());
    const after = await startOtlpCollector();
    onCleanup(() => after.close());
    const stack = await startStack({}, { telemetry: { otlp: { endpoint: before.endpoint } } });
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const hold = stack.hold();
    const running = await launched.createRun(session.id, { input: 'first' });
    await hold.waitForRequest();
    stack.settings({ telemetry: { otlp: { endpoint: after.endpoint } } });
    hold.release();
    expect(await waitForStatus(stack.temp, running.id, FINAL)).toBe('COMPLETED');
    const next = await launched.createRun(session.id, { input: 'second' });
    expect(await waitForStatus(stack.temp, next.id, FINAL)).toBe('COMPLETED');
    await launched.handle.close();
    const tracesOf = (collector: typeof before) => new Set(decodeOtlpSpans(collector.requests).filter((span) => span.service === 'momonga-runtime').map((span) => span.traceId));
    const old = tracesOf(before);
    const fresh = tracesOf(after);
    expect(old.size, 'the running run exported its spans to the old provider').toBe(1);
    expect(fresh.size, 'the next run exported its spans to the new provider').toBe(1);
    expect([...fresh].some((trace) => old.has(trace)), 'no span of the running run reached the new provider').toBe(false);
  });
});
