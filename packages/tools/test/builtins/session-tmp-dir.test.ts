import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, testProbes, NEVER_CANCELLED } from '@momonga/testkit';
import { momongaLayout, EMPTY_PROTECTED_SET, ruleEnforcementOf } from '@momonga/foundation';
import { computeFileRules } from '@momonga/policy';
import { buildSandboxPolicy } from '@momonga/tools';
import { HAS_REAL_SANDBOX, HOST_SANDBOX_KIND } from '../helpers.ts';
import { makeBuiltins, resultOf } from './fixtures.ts';
import type { RunExtra } from './fixtures.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const fixture = async () => {
  const tools = await makeBuiltins({ realSandbox: true });
  const { home, project } = tools.layout;
  const sessions = momongaLayout(home, process.platform, {}).tmp.sessions;
  const tmpDir = path.join(sessions, 'session-1');
  const sibling = path.join(sessions, 'session-2');
  for (const dir of [tmpDir, sibling]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sibling, 'secret'), 'sibling-secret');
  const marker = path.join(project, 'ran');
  const extra: RunExtra = {
    roots: [project],
    tmpDir,
    sandboxPolicy: await buildSandboxPolicy({ layout: momongaLayout(home, process.platform, process.env), protectedSet: EMPTY_PROTECTED_SET, fileRules: await computeFileRules([], [project], tmpDir, ruleEnforcementOf(HOST_SANDBOX_KIND), testProbes()), roots: [project], home, tmpDir, sessionsTmpRoot: sessions }, NEVER_CANCELLED),
  };
  return { tools, sessions, tmpDir, sibling, marker, extra };
};

describe.runIf(HAS_REAL_SANDBOX)('Bash session tmp dir (real sandbox, production policy)', () => {
  it('keeps $TMPDIR files across Bash calls of one session', async () => {
    const fx = await fixture();
    const first = resultOf(await fx.tools.run('Bash', { command: 'printf persisted > "$TMPDIR/f"; printf %s "$TMPDIR"' }, fx.extra, 'allow_once'));
    expect(first.status).toBe('completed');
    expect(first.output).toBe(fx.tmpDir);
    expect(fs.readFileSync(path.join(fx.tmpDir, 'f'), 'utf8')).toBe('persisted');

    const second = resultOf(await fx.tools.run('Bash', { command: 'cat "$TMPDIR/f"' }, fx.extra, 'allow_once'));
    expect(second.status).toBe('completed');
    expect(second.output).toBe('persisted');
  });

  it('cannot list the sessions root', async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Bash', { command: `touch '${fx.marker}' && ls '${fx.sessions}'` }, fx.extra, 'allow_once'));
    expect(fs.existsSync(fx.marker)).toBe(true);
    expect(result.status).toBe(process.platform === 'darwin' ? 'failed' : 'completed');
    expect(result.output).not.toContain('session-2');
  });

  it("cannot read a sibling session's file", async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Bash', { command: `touch '${fx.marker}' && cat '${path.join(fx.sibling, 'secret')}'` }, fx.extra, 'allow_once'));
    expect(fs.existsSync(fx.marker)).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain('sibling-secret');
  });
});
