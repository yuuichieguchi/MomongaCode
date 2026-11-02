import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import type { SandboxedProcess } from '@momonga/sandbox';
import { killGroupsForCleanup } from '@momonga/testkit';
import { buildSandboxPolicy } from '@momonga/tools';
import { START_MS, onCleanup, requestManualApproval, startService, toolCallPayload } from './helpers.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(!fs.existsSync(SANDBOX_EXEC))('run API boundary under real Seatbelt', () => {
  it.each([
    { network: 'allow' as const, controlLine: 'control-ok control=0', controlRequests: ['GET /control'] },
    { network: 'deny' as const, controlLine: ' control=7', controlRequests: [] },
  ])(
    'keeps a sandboxed shell with network $network from reaching the run socket',
    async ({ network, controlLine, controlRequests: expectedControlRequests }) => {
      const env = await startService();
      const session = await env.createSession();
      const run = await env.createRun(session.id);
      const claim = env.claimRun(run.id);
      env.append(claim, [toolCallPayload('call_1', path.join(env.layout.projectReal, 'a.txt'))]);
      const approvalId = requestManualApproval(env, claim, 'call_1', START_MS + 600_000);
      expect(env.store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');

      const controlSocket = path.join(env.layout.projectReal, 'c.sock');
      const controlRequests: string[] = [];
      const control = http.createServer((request, response) => {
        controlRequests.push(`${request.method} ${request.url}`);
        response.end('control-ok');
      });
      await new Promise<void>((resolve) => control.listen(controlSocket, resolve));
      onCleanup(() => new Promise<void>((resolve) => control.close(() => resolve())));

      const sessionsTmpRoot = path.join(env.layout.root, 'sessions');
      const tmpDir = path.join(sessionsTmpRoot, 'session-x');
      const sandboxTmp = path.join(env.layout.root, 'st');
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(sandboxTmp);
      const sandbox = createSeatbeltSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 });
      const policy = buildSandboxPolicy({ protectedSet: EMPTY_PROTECTED_SET, fileRules: EMPTY_FILE_RULES, roots: [env.layout.projectReal], home: env.layout.home, tmpDir, sessionsTmpRoot, network });
      const marker = path.join(env.layout.projectReal, 'ran.txt');
      const runSocket = env.layout.socketPath;
      const script = [
        `echo started > ${quote(marker)}`,
        `/usr/bin/curl -s --max-time 5 --unix-socket ${quote(controlSocket)} http://localhost/control; echo " control=$?"`,
        `/usr/bin/curl -s --max-time 5 --unix-socket ${quote(runSocket)} -X PATCH -H 'content-type: application/json' -d '{"permissionMode":"bypassPermissions"}' http://localhost/v1/sessions/${session.id}; echo " patch=$?"`,
        `/usr/bin/curl -s --max-time 5 --unix-socket ${quote(runSocket)} -X POST -H 'content-type: application/json' -d '{"optionId":"opt-allow-once"}' http://localhost/v1/approvals/${approvalId}; echo " approve=$?"`,
        `printf 'GET /v1/health HTTP/1.0\\r\\n\\r\\n' | /usr/bin/nc -U ${quote(runSocket)}; echo " nc=$?"`,
      ].join('\n');

      const controller = new AbortController();
      onCleanup(() => controller.abort());
      const proc: SandboxedProcess = sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: env.layout.projectReal, env: BASE_ENV }, policy, controller.signal);
      onCleanup(() => killGroupsForCleanup([proc.pgid]));
      const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);

      expect({ stdout, stderr, code: exit.code }).toMatchObject({ code: 0 });
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('started');
      expect(stdout).toContain(controlLine);
      expect(controlRequests).toEqual(expectedControlRequests);
      expect(stdout).toMatch(/ patch=7\b/);
      expect(stdout).toMatch(/ approve=7\b/);
      expect(stdout).toMatch(/ nc=[1-9]\d*\b/);
      expect(stdout).not.toContain('HTTP/1');
      expect(stdout).not.toContain('"status"');

      expect(env.store.getSession(session.id)?.permissionMode).toBe('default');
      expect((await env.http('GET', `/v1/approvals/${approvalId}`)).json.approval.status).toBe('pending');
      expect((await env.getRun(run.id)).status).toBe('WAITING_HUMAN');
    },
    30_000,
  );
});
