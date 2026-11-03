import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem } from '@momonga/testkit';
import { ConfigError } from '@momonga/config';
import { HOST_RULE_ENFORCEMENT, ensureSessionTmpDir, momongaLayout, protectedSetFor } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import type { MomongaPaths } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import type { Session } from '@momonga/store';
import { buildSandboxPolicy } from '@momonga/tools';
import { BASE_ENV, HAS_SEATBELT, createSession, errnoError, makeDir, makeLogger, makeTempHome, openStore, runSandboxed } from './helpers.ts';
import type { TempHome } from './helpers.ts';

type EnsureTmpDir = (paths: MomongaPaths, sessionId: string) => Promise<string>;

const setup = async (options: { ensure?: EnsureTmpDir; sessionStates?: { get(session: Pick<Session, 'id' | 'cwd'>): unknown } } = {}) => {
  const temp = await makeTempHome();
  const { store, clock } = openStore(temp);
  const states = runtime.createSessionStates({ clock, store, logger: makeLogger() });
  const policyFor = runtime.createPolicyFor({
    paths: temp.paths,
    home: temp.home,
    fs: fakePolicyFilesystem(),
    ruleEnforcement: 'exact-paths',
    sessionStates: (options.sessionStates ?? states) as typeof states,
    ...(options.ensure === undefined ? {} : { ensureSessionTmpDir: options.ensure }),
  });
  return { temp, store, states, policyFor };
};

const env = (): Readonly<Record<string, string>> => Object.freeze({ PLAIN: '1' });

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

const expectWrapped = (error: unknown, sessionId: string): void => {
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message.startsWith(`the tool policy for session ${sessionId} could not be built: `)).toBe(true);
  expect((error as Error).cause).toBeDefined();
  const cause = (error as Error).cause as Error;
  expect((error as Error).message).toBe(`the tool policy for session ${sessionId} could not be built: ${cause.message}`);
};

const sessionTmpDirOf = (temp: TempHome, session: Session): string => path.join(temp.paths.tmp.sessions, session.id);

describe('policyFor and readable skill directories', () => {
  it('allows reading a skill directory below ~/.momonga/skills while the rest of ~/.momonga stays denied', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const skill = makeDir(temp.paths.skills, 'pdf');
    const sibling = makeDir(temp.paths.root, 'projects-copy');

    const policy = await policyFor(session, { env: env(), rules: [], readableDirectories: [skill, sibling] });

    expect(policy.sandboxPolicy.readAllowed).toContain(skill);
    expect(policy.sandboxPolicy.readAllowed).not.toContain(sibling);
    expect(policy.sandboxPolicy.readDenied).toContain(temp.paths.root);
    expect(policy.sandboxPolicy.writeDenied).toContain(temp.paths.root);
  });

  it('leaves skill directories elsewhere out of the sandbox exceptions because nothing denies them', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    const agentsSkill = makeDir(temp.home, '.agents', 'skills', 'pdf');

    const policy = await policyFor(session, { env: env(), rules: [], readableDirectories: [agentsSkill] });

    expect(policy.sandboxPolicy.readAllowed).not.toContain(agentsSkill);
  });
});

describe('policyFor (system timers, none used)', () => {
  it('policyFor creates a 0700 tmp dir, roots exclude it, the protected set covers the same roots and writableRoots include it', async () => {
    const { temp, store, policyFor } = await setup();
    const extra = makeDir(temp.root, 'extra');
    const session = createSession(store, temp.project, { additionalDirectories: [extra] });
    const given = env();

    const policy = await policyFor(session, { env: given, rules: [] });

    const tmpDir = sessionTmpDirOf(temp, session);
    expect(policy.tmpDir).toBe(tmpDir);
    expect(fs.statSync(tmpDir).isDirectory()).toBe(true);
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(policy.roots).toEqual([temp.project, extra]);
    expect(policy.roots).not.toContain(tmpDir);
    expect('protectedPaths' in policy).toBe(false);
    const protectedSet = protectedSetFor([temp.project, extra], fakePolicyFilesystem());
    expect(policy.sandboxPolicy.protectedSet).toEqual(protectedSet);
    expect(policy.sandboxPolicy.protectedSet.roots).toEqual([temp.project, extra]);
    expect(policy.sandboxPolicy.writableRoots).toContain(tmpDir);
    expect(policy.sandboxPolicy).toEqual(
      buildSandboxPolicy({
        fileRules: computeFileRules([], [temp.project, extra], tmpDir, HOST_RULE_ENFORCEMENT),
        protectedSet,
        roots: [temp.project, extra],
        home: temp.home,
        tmpDir,
        sessionsTmpRoot: temp.paths.tmp.sessions,
        network: 'deny',
      }),
    );
    expect(policy.sandboxPolicy.network).toBe('deny');
    expect(policy.sandboxPolicy.readDenied).toEqual(
      expect.arrayContaining([path.join(temp.home, '.momonga'), momongaLayout(temp.home).keychains, temp.paths.tmp.sessions]),
    );
  });

  it('policyFor resets the tmp dir mode to 0700 on every call', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project);
    await policyFor(session, { env: env(), rules: [] });
    fs.chmodSync(sessionTmpDirOf(temp, session), 0o755);

    await policyFor(session, { env: env(), rules: [] });

    expect(fs.statSync(sessionTmpDirOf(temp, session)).mode & 0o777).toBe(0o700);
  });

  it('policyFor registers the session in-memory state before creating the tmp dir', async () => {
    let states: { has(id: string): boolean } | undefined;
    const seen: boolean[] = [];
    const ensure: EnsureTmpDir = async (paths, sessionId) => {
      seen.push(states?.has(sessionId) === true);
      return ensureSessionTmpDir(paths, sessionId);
    };
    const fixture = await setup({ ensure });
    states = fixture.states;
    const session = createSession(fixture.store, fixture.temp.project);
    expect(fixture.states.has(session.id)).toBe(false);

    await fixture.policyFor(session, { env: env(), rules: [] });

    expect(seen).toEqual([true]);
    expect(fixture.states.get(session).cwd).toBe(fixture.temp.project);
  });

  it('policyFor returns the env it was given as policy.env (the same object)', async () => {
    const { temp, store, policyFor } = await setup();
    const session = createSession(store, temp.project, { env: { OTHER: 'x' } });
    const given = env();

    const policy = await policyFor(session, { env: given, rules: [] });

    expect(policy.env).toBe(given);
  });

  describe.runIf(HAS_SEATBELT)('real Seatbelt', () => {
    it('Bash $TMPDIR persists between calls of a session', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      const sandbox = createSeatbeltSandbox({ tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 });

      const first = await policyFor(session, { env: env(), rules: [] });
      const write = await runSandboxed(sandbox, first.sandboxPolicy, { script: 'printf kept > "$TMPDIR/note" && printf "%s" "$TMPDIR"', cwd: temp.project, env: BASE_ENV, tmpDir: first.tmpDir });
      const second = await policyFor(session, { env: env(), rules: [] });
      const read = await runSandboxed(sandbox, second.sandboxPolicy, { script: 'cat "$TMPDIR/note"', cwd: temp.project, env: BASE_ENV, tmpDir: second.tmpDir });

      expect(write.code).toBe(0);
      expect(write.stdout).toBe(first.tmpDir);
      expect(second.tmpDir).toBe(first.tmpDir);
      expect(read).toMatchObject({ code: 0, stdout: 'kept' });
    });

    it("another session's tmp dir is unreadable", { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, async () => {
      const { temp, store, policyFor } = await setup();
      const mine = createSession(store, temp.project);
      const other = createSession(store, temp.project);
      const sandbox = createSeatbeltSandbox({ tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 });
      const otherPolicy = await policyFor(other, { env: env(), rules: [] });
      fs.writeFileSync(path.join(otherPolicy.tmpDir, 'secret.txt'), 'hidden');
      const minePolicy = await policyFor(mine, { env: env(), rules: [] });

      const result = await runSandboxed(sandbox, minePolicy.sandboxPolicy, {
        script: `cat '${path.join(otherPolicy.tmpDir, 'secret.txt')}'`,
        cwd: temp.project,
        env: BASE_ENV,
        tmpDir: minePolicy.tmpDir,
      });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
    });
  });

  describe('invariant violations become ConfigError with cause', () => {
    it('a session tmp dir replaced by a symlink', async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      await policyFor(session, { env: env(), rules: [] });
      const tmpDir = sessionTmpDirOf(temp, session);
      fs.rmSync(tmpDir, { recursive: true });
      fs.symlinkSync(makeDir(temp.root, 'elsewhere'), tmpDir);

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
    });

    it('the sessions root replaced by a symlink', async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      const moved = `${temp.paths.tmp.sessions}-moved`;
      fs.renameSync(temp.paths.tmp.sessions, moved);
      fs.symlinkSync(moved, temp.paths.tmp.sessions);

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
    });

    it('a root replaced by a file', async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      fs.rmSync(temp.project, { recursive: true });
      fs.writeFileSync(temp.project, 'not a directory');

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
    });

    it('a removed root', async () => {
      const { temp, store, policyFor } = await setup();
      const extra = makeDir(temp.root, 'extra');
      const session = createSession(store, temp.project, { additionalDirectories: [extra] });
      fs.rmSync(extra, { recursive: true });

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
    });

    it('a root in a symlink loop', async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      fs.rmSync(temp.project, { recursive: true });
      fs.symlinkSync(temp.project, temp.project);

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
    });

    it('a root check fails before a tmp dir is created', async () => {
      const { temp, store, policyFor } = await setup();
      const session = createSession(store, temp.project);
      fs.rmSync(temp.project, { recursive: true });

      expectWrapped(await rejectionOf(policyFor(session, { env: env(), rules: [] })), session.id);
      expect(fs.existsSync(sessionTmpDirOf(temp, session))).toBe(false);
    });
  });

  it.each(['EIO', 'EMFILE', 'ENOSPC', 'EDQUOT'])('a transient errno from ensureSessionTmpDir (%s) propagates unchanged and is not a ConfigError', async (code) => {
    const failure = errnoError(code);
    const { temp, store, policyFor } = await setup({ ensure: async () => Promise.reject(failure) });
    const session = createSession(store, temp.project);

    const error = await rejectionOf(policyFor(session, { env: env(), rules: [] }));

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ConfigError);
  });

  it.each(['EACCES', 'ENOENT', 'EPERM'])('a non-transient errno from ensureSessionTmpDir (%s) becomes ConfigError with the errno as cause', async (code) => {
    const failure = errnoError(code);
    const { temp, store, policyFor } = await setup({ ensure: async () => Promise.reject(failure) });
    const session = createSession(store, temp.project);

    const error = await rejectionOf(policyFor(session, { env: env(), rules: [] }));

    expectWrapped(error, session.id);
    expect((error as Error).cause).toBe(failure);
  });

  it('a non-transient errno error from buildSandboxPolicy (EACCES) and an assertion error from it both become ConfigError', async () => {
    const temp = await makeTempHome();
    const locked = makeDir(temp.root, 'locked');
    const lockedTmp = path.join(locked, 'session-tmp');
    const errnoCase = await setup({ ensure: async () => lockedTmp });
    const errnoSession = createSession(errnoCase.store, errnoCase.temp.project);
    fs.chmodSync(locked, 0o000);

    const errnoFailure = await rejectionOf(errnoCase.policyFor(errnoSession, { env: env(), rules: [] }));
    fs.chmodSync(locked, 0o700);

    expectWrapped(errnoFailure, errnoSession.id);
    expect(((errnoFailure as Error).cause as NodeJS.ErrnoException).code).toBe('EACCES');

    const assertionCase = await setup({ ensure: async () => 'relative-tmp' });
    const assertionSession = createSession(assertionCase.store, assertionCase.temp.project);

    const assertionFailure = await rejectionOf(assertionCase.policyFor(assertionSession, { env: env(), rules: [] }));

    expectWrapped(assertionFailure, assertionSession.id);
    expect(((assertionFailure as Error).cause as NodeJS.ErrnoException).code).toBe('entry_not_absolute');
  });

  it('a ConfigError is not wrapped twice', async () => {
    const failure = new ConfigError('already a config error');
    const { temp, store, policyFor } = await setup({ ensure: async () => Promise.reject(failure) });
    const session = createSession(store, temp.project);

    expect(await rejectionOf(policyFor(session, { env: env(), rules: [] }))).toBe(failure);
  });

  it('a store error is never wrapped', async () => {
    const failure = Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    const { temp, store, policyFor } = await setup({
      sessionStates: {
        get: () => {
          throw failure;
        },
      },
    });
    const session = createSession(store, temp.project);

    expect(await rejectionOf(policyFor(session, { env: env(), rules: [] }))).toBe(failure);
  });

  it('a relative home raises TypeError', async () => {
    const temp = await makeTempHome();
    const { store, clock } = openStore(temp);
    const sessionStates = runtime.createSessionStates({ clock, store, logger: makeLogger() });
    let error: unknown;
    try {
      runtime.createPolicyFor({ paths: temp.paths, home: 'relative/home', sessionStates, fs: fakePolicyFilesystem(), ruleEnforcement: 'exact-paths' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('relative/home');
  });
});
