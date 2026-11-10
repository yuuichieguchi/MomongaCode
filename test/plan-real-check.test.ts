import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createJsonLogger, momongaLayout } from '@momonga/foundation';
import type { LogFields } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, openResponsesTextReply, withTempDir } from '@momonga/testkit';
import type { FakeClock } from '@momonga/testkit';
import { userInput } from '../packages/gateway/test/gateway-helpers.ts';
import { clientFor } from '../packages/gateway/test/gateway-process-helpers.ts';
import { ACCOUNT, accountRoute, begin, browse, startPlanGateway } from '../packages/gateway/test/plan-signin-support.ts';
import type { PlanGateway } from '../packages/gateway/test/plan-signin-support.ts';
import { PROFILE_ID } from '../packages/gateway/test/plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts', 'plan-real-check.ts');
const REPORT_FORMAT = 'momonga-plan-real-check/1';
const SPARE = 'spare';

type Run = { code: number; stdout: string; stderr: string };

const runScript = (args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });

type Report = { format: string; generatedAt: string; account: unknown; steps: Array<{ step: string; verdict: string; facts: unknown }> };

const readReport = (file: string): Report => JSON.parse(fs.readFileSync(file, 'utf8')) as Report;

const verdictOf = (report: Report, step: string): string | undefined => report.steps.find((entry) => entry.step === step)?.verdict;

const fileLogger = (home: string, clock: FakeClock) => {
  const file = momongaLayout(home).logFiles.gateway;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return createJsonLogger({ service: 'gateway', clock, stream: {
      write: (text: string) => {
        fs.appendFileSync(file, text);
        return true;
      },
    },
  });
};

const signInAs = async (gateway: PlanGateway, account: string) => {
  const begun = await begin(gateway, { account });
  expect(begun.status).toBe(200);
  const callback = await browse(begun.body.authorizationUrl);
  const completed = await gateway.post(PLAN_ROUTES.signInComplete, { attemptId: begun.body.attemptId, callbackUrl: callback.toString() });
  expect(completed.body).toMatchObject({ outcome: 'signed_in', account: { label: account } });
  const authorization = new URL(begun.body.authorizationUrl as string);
  return [callback.searchParams.get('code') ?? '', authorization.searchParams.get('state') ?? '', authorization.searchParams.get('nonce') ?? '', authorization.toString(), callback.toString()];
};

const tokenShaped = (): string => ['ey', 'J', 'x'.repeat(12), '.', 'y'.repeat(12), '.', 'z'.repeat(4)].join('');

describe('O-R5-6 L10: scripts/plan-real-check.ts against the fakes only', () => {
  it('a home with no evidence gives not_run for every step and exit 1', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const report = path.join(withTempDir(context), 'report.json');
    const run = await runScript(['collect', '--home', home, '--report', report]);
    expect(run.code).toBe(1);
    const written = readReport(report);
    expect(written.format).toBe(REPORT_FORMAT);
    expect(written.steps.length).toBeGreaterThan(0);
    for (const step of written.steps) expect(step.verdict).toBe('not_run');
  });

  it('a usage error exits 2', async () => {
    expect((await runScript([])).code).toBe(2);
    expect((await runScript(['collect'])).code).toBe(2);
  });

  it('a token-shaped string that would reach the report fires the leak check: exit 3, nothing written, the value never printed', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const clock = createFakeClock(Date.now());
    const injected = tokenShaped();
    const logger = fileLogger(home, clock);
    for (const scope of [injected, 'openid']) {
      logger.info('plan.sign_in', { data: { profile: PROFILE_ID, account: ACCOUNT, outcome: 'signed_in', endStep: 10, durationMs: 5, port: 49152, alg: 'RS256', kid: 'kid-1', audShape: 'string', scope, earliestRefreshAt: 'opaque-1', claimNames: ['sub'] } });
    }
    const report = path.join(withTempDir(context), 'report.json');
    const run = await runScript(['collect', '--home', home, '--report', report]);
    expect(run.code).toBe(3);
    expect(fs.existsSync(report)).toBe(false);
    expect(`${run.stdout}${run.stderr}`).not.toContain(injected);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim()).toBe('plan-real-check: R1 field scope looks like a token, so nothing was written.');
  });

  it('a 45-character run in earliestRefreshAt fires the check, and --allow-long R3.earliestRefreshAt lets exactly that field through', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const clock = createFakeClock(Date.now());
    const long = 'a'.repeat(45);
    const at = new Date(clock.now()).toISOString();
    fileLogger(home, clock).info('plan.refresh', {
      data: { profile: PROFILE_ID, account: ACCOUNT, outcome: 'adopted', attempts: 1, latencyMs: 12, remainingMs: 61000, earliestRefreshAt: long, at },
    });
    const reports = withTempDir(context);
    const refused = path.join(reports, 'refused.json');
    const run = await runScript(['collect', '--home', home, '--report', refused]);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.stderr.trim()).toBe(
      'plan-real-check: R3 field earliestRefreshAt looks like a long token, so nothing was written. If it is a value you may share, run again with --allow-long R3.earliestRefreshAt.',
    );
    expect(fs.existsSync(refused)).toBe(false);
    const allowed = path.join(reports, 'allowed.json');
    const passed = await runScript(['collect', '--home', home, '--report', allowed, '--allow-long', 'R3.earliestRefreshAt']);
    expect(passed.code).toBe(1);
    const report = readReport(allowed);
    const r3 = report.steps.find((entry) => entry.step === 'R3');
    expect(r3).toEqual({ step: 'R3', verdict: 'recorded', facts: { remainingMs: 61000, earliestRefreshAt: long, at } });
  });

  it("--home equal to the user's home directory exits 2 with the refusal text", async (context) => {
    const userHome = withTempDir(context);
    const reports = withTempDir(context);
    const report = path.join(reports, 'report.json');
    expect(fs.readdirSync(userHome)).toEqual([]);
    const run = await runScript(['collect', '--home', userHome, '--report', report], { ...process.env, HOME: userHome });
    expect(run.code).toBe(2);
    expect(run.stderr.trim()).toBe(
      'plan-real-check: --home is your own home directory. Use the temporary HOME in which you signed in; this script never touches ~/.momonga.',
    );
    expect(fs.readdirSync(userHome)).toEqual([]);
    expect(fs.existsSync(report)).toBe(false);
    expect(userHome).not.toBe(os.homedir());
  });

  it('collects the steps of a driven sign-in, request, refresh, catalog read and logout, and no issued token, code, state, nonce, URL, email or sub reaches a report', async (context) => {
    const clock = createFakeClock(Date.now());
    const logClock = createFakeClock(Date.now());
    let logger: ReturnType<typeof fileLogger> | undefined;
    const proxyLogger = {
      debug: (msg: string, fields?: LogFields) => logger?.debug(msg, fields),
      info: (msg: string, fields?: LogFields) => logger?.info(msg, fields),
      warn: (msg: string, fields?: LogFields) => logger?.warn(msg, fields),
      error: (msg: string, fields?: LogFields) => logger?.error(msg, fields),
    };
    const gateway = await startPlanGateway({
      clock,
      plaintextTokenFiles: true,
      models: [{ slug: 'plan-model', display_name: 'Plan Model', visibility: 'list', context_window: 200000 }],
      respond: () => openResponsesTextReply(['hi']),
      logger: proxyLogger,
    });
    logger = fileLogger(gateway.home, logClock);
    const exposed = [...(await signInAs(gateway, ACCOUNT)), ...(await signInAs(gateway, SPARE))];
    const asked = await clientFor(gateway.socketPath).request({ method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'default', input: userInput('hi'), stream: false }) });
    await asked.text();
    expect(asked.status).toBe(200);
    const catalog = `${accountRoute(PLAN_ROUTES.accountModels)}?profile=${PROFILE_ID}&refresh=1`;
    expect((await gateway.get(catalog)).status).toBe(200);
    clock.advance(86_400_000);
    expect((await gateway.get(catalog)).status).toBe(200);
    expect(gateway.auth.calls.tokenRefreshToken).toBe(1);
    expect((await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: SPARE })).status).toBe(200);

    const reports = withTempDir(context);
    const collected = path.join(reports, 'collect.json');
    const collect = await runScript(['collect', '--home', gateway.home, '--report', collected]);
    expect(collect.code).toBe(1);
    const report = readReport(collected);
    expect(report.format).toBe(REPORT_FORMAT);
    expect(report.account).toBe('work');
    for (const step of ['R1', 'R3', 'R5', 'R7']) expect(verdictOf(report, step), step).toBe('recorded');

    const carriage = path.join(reports, 'carriage.json');
    const carried = await runScript(['carriage', '--home', gateway.home, '--alias', 'default', '--report', carriage]);
    expect(carried.code).toBe(0);
    const carriedReport = readReport(carriage);
    expect(carriedReport.format).toBe(REPORT_FORMAT);
    expect(carriedReport.steps.map((entry) => entry.step)).toEqual(['R2', 'R4']);
    const r4 = carriedReport.steps.find((entry) => entry.step === 'R4')?.facts as { requests: Array<{ status: unknown }> };
    expect(r4.requests).toHaveLength(4);
    for (const request of r4.requests) expect(typeof request.status).toBe('number');
    const sized = path.join(reports, 'request-size.json');
    const sizing = await runScript(['request-size', '--home', gateway.home, '--alias', 'default', '--report', sized]);
    expect(sizing.code).toBe(0);
    const sizedReport = readReport(sized);
    expect(sizedReport.format).toBe(REPORT_FORMAT);
    expect(sizedReport.steps.map((entry) => entry.step)).toEqual(['R6']);
    expect(sizedReport.steps[0]?.facts).toMatchObject({ bytes: 1048577 });

    const forbidden = [...gateway.auth.issuedSecrets(), ...exposed, gateway.auth.identity.email, gateway.auth.identity.sub, ...gateway.auth.registrations().flatMap((registration) => [registration.clientId, registration.hostId])].filter((value) => value !== '');
    const outputs = [collected, carriage, sized].map((file) => fs.readFileSync(file, 'utf8')).join('\n') + collect.stdout + carried.stdout + sizing.stdout;
    for (const value of forbidden) expect(outputs.includes(value), 'a report carries a value the design forbids (O-R5-6 L10)').toBe(false);
    const log = fs.readFileSync(momongaLayout(gateway.home).logFiles.gateway, 'utf8');
    const events = log.split('\n').filter((line) => /"msg":"plan\./.test(line));
    expect(events.length).toBeGreaterThan(0);
    for (const value of forbidden) expect(events.join('\n').includes(value), 'a plan event carries a value the design forbids (O-R5-6 L10)').toBe(false);
    await gateway.close();
  });
});
