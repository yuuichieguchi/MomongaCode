import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@momonga/config';
import { waitFor, NEVER_CANCELLED } from '@momonga/testkit';
import { createRun, createSession, errnoError, makeRuntimeFixture, signalNever, writeJson, writeProjectSettings, writeUserSettings } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const failReadsOf = (target: string, failure: unknown): void => {
  const original = fs.promises.readFile;
  vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && path.resolve(file) === target) return Promise.reject(failure);
    return (original as (...args: unknown[]) => Promise<unknown>).call(fs.promises, file, ...rest);
  }) as typeof fs.promises.readFile);
};

const trustedProject = async () => {
  const f = await makeRuntimeFixture();
  writeUserSettings(f.temp.home, {});
  await f.store.trust.setAsked(f.temp.project, 'trusted', NEVER_CANCELLED);
  const session = createSession(f.store, f.temp.project, { env: { PATH: '/usr/bin:/bin' } });
  const runId = await createRun(f.store, session.id);
  return { f, session, runId };
};

describe('transient errno and abort rules of the runtime composition (system timers, none used)', () => {
  it.each(['EMFILE', 'EIO'])('a %s reading the project settings propagates unchanged out of settings.rules, sessionCreateSettings and toolSet', async (code) => {
    const { f, session, runId } = await trustedProject();
    const settingsFile = path.join(f.temp.project, '.momonga', 'settings.json');
    writeProjectSettings(f.temp.project, { permissions: { allow: ['Bash(ls)'] } });
    const failure = errnoError(code);
    failReadsOf(settingsFile, failure);

    const rules = await rejectionOf(f.composition.settings.rules(session, new AbortController().signal));
    const created = await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()));
    const toolSet = await rejectionOf(f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PATH: '/usr/bin:/bin' }) }));

    for (const error of [rules, created, toolSet]) {
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(ConfigError);
    }
  });

  it.each(['EMFILE', 'EIO'])('a %s reading .mcp.json propagates unchanged out of toolSet', async (code) => {
    const { f, runId } = await trustedProject();
    const mcpJson = path.join(f.temp.project, '.mcp.json');
    writeJson(mcpJson, { mcpServers: { a: { command: '/bin/echo' } } });
    const failure = errnoError(code);
    failReadsOf(mcpJson, failure);

    const error = await rejectionOf(f.toolRuntime.port.toolSet(runId, { signal: signalNever(), env: Object.freeze({ PATH: '/usr/bin:/bin' }) }));

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ConfigError);
  });

  it('EACCES on the project settings file is still a ConfigError', async () => {
    const { f, session } = await trustedProject();
    writeProjectSettings(f.temp.project, { permissions: { allow: ['Bash(ls)'] } });
    fs.chmodSync(path.join(f.temp.project, '.momonga', 'settings.json'), 0o000);

    const rules = await rejectionOf(f.composition.settings.rules(session, new AbortController().signal));
    const created = await rejectionOf(f.composition.sessionCreateSettings(f.temp.project, signalNever()));

    expect(rules).toBeInstanceOf(ConfigError);
    expect(created).toBeInstanceOf(ConfigError);
    expect(((rules as Error).cause as NodeJS.ErrnoException | undefined)?.code ?? (rules as Error).message).toMatch(/EACCES|permission/i);
  });

  it('a transient errno in the policyFor root check propagates as the same error', async () => {
    const { f, session } = await trustedProject();
    const failure = errnoError('EMFILE');
    const original = fs.promises.stat;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      if (typeof target === 'string' && target === f.temp.project) throw failure;
      return (original as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.promises.stat);

    const error = await rejectionOf(f.toolRuntime.port.policyFor(session, { signal: NEVER_CANCELLED, env: Object.freeze({ PATH: '/usr/bin:/bin' }), rules: [], ruleEnforcement: 'exact-paths' }));

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ConfigError);
  });

  it('when the abort fires during loadSessionSettings and the load also fails, toolSet rejects with signal.reason', async () => {
    const { f, runId } = await trustedProject();
    const settingsFile = path.join(f.temp.project, '.momonga', 'settings.json');
    writeProjectSettings(f.temp.project, {});
    let failLoad: (error: unknown) => void = () => undefined;
    let loading = false;
    const original = fs.promises.readFile;
    vi.spyOn(fs.promises, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file === 'string' && path.resolve(file) === settingsFile) {
        loading = true;
        return new Promise((_resolve, reject) => {
          failLoad = reject;
        });
      }
      return (original as (...args: unknown[]) => Promise<unknown>).call(fs.promises, file, ...rest);
    }) as typeof fs.promises.readFile);
    const controller = new AbortController();
    const reason = new Error('the claim was cancelled');

    const pending = f.toolRuntime.port.toolSet(runId, { signal: controller.signal, env: Object.freeze({ PATH: '/usr/bin:/bin' }) });
    await waitFor(() => loading, { description: 'the project settings load to start' });
    controller.abort(reason);
    failLoad(new SyntaxError('Unexpected end of JSON input'));

    expect(await rejectionOf(pending)).toBe(reason);
  });
});
