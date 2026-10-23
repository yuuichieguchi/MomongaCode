import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';
import { buildSandboxPolicy } from '@momonga/tools';
import { makeBuiltins, resultOf } from './fixtures.ts';
import type { RunExtra } from './fixtures.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

const fixture = async () => {
  const tools = await makeBuiltins({ realSandbox: true });
  const { home, project } = tools.layout;
  const sessions = momongaLayout(home, 'darwin', {}).tmp.sessions;
  const tmpDir = path.join(sessions, 'session-1');
  const sibling = path.join(sessions, 'session-2');
  for (const dir of [tmpDir, sibling]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sibling, 'secret'), 'sibling-secret');
  const marker = path.join(project, 'ran');
  const extra: RunExtra = {
    roots: [project],
    tmpDir,
    sandboxPolicy: buildSandboxPolicy({ roots: [project], home, tmpDir, sessionsTmpRoot: sessions }),
  };
  return { tools, sessions, tmpDir, sibling, marker, extra };
};

describe.runIf(HAS_SEATBELT)('Bash session tmp dir (real Seatbelt, production policy)', () => {
  it('keeps $TMPDIR files across Bash calls of one session', PROCESS_TIMEOUT, async () => {
    const fx = await fixture();
    const first = resultOf(await fx.tools.run('Bash', { command: 'printf persisted > "$TMPDIR/f"; printf %s "$TMPDIR"' }, fx.extra, 'allow_once'));
    expect(first.status).toBe('completed');
    expect(first.output).toBe(fx.tmpDir);
    expect(fs.readFileSync(path.join(fx.tmpDir, 'f'), 'utf8')).toBe('persisted');

    const second = resultOf(await fx.tools.run('Bash', { command: 'cat "$TMPDIR/f"' }, fx.extra, 'allow_once'));
    expect(second.status).toBe('completed');
    expect(second.output).toBe('persisted');
  });

  it('cannot list the sessions root', PROCESS_TIMEOUT, async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Bash', { command: `touch '${fx.marker}' && ls '${fx.sessions}'` }, fx.extra, 'allow_once'));
    expect(fs.existsSync(fx.marker)).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain('session-2');
  });

  it("cannot read a sibling session's file", PROCESS_TIMEOUT, async () => {
    const fx = await fixture();
    const result = resultOf(await fx.tools.run('Bash', { command: `touch '${fx.marker}' && cat '${path.join(fx.sibling, 'secret')}'` }, fx.extra, 'allow_once'));
    expect(fs.existsSync(fx.marker)).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain('sibling-secret');
  });
});
