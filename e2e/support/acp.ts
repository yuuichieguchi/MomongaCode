import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  ClientCapabilities,
  ClientConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { CLI_BUNDLE, cliEnv } from './cli.ts';
import { registerE2eCleanup } from './home.ts';
import type { E2eHome } from './home.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, until, withinBound } from './wait.ts';

export type AcpExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export type AcpClientOptions = {
  capabilities?: ClientCapabilities;
  permission?: (request: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  elicitation?: (request: CreateElicitationRequest) => CreateElicitationResponse | Promise<CreateElicitationResponse>;
};

export type AcpClient = {
  readonly agent: ClientConnection['agent'];
  readonly updates: readonly SessionNotification[];
  readonly permissionRequests: readonly RequestPermissionRequest[];
  readonly elicitationRequests: readonly CreateElicitationRequest[];
  readonly wire: readonly string[];
  initialize(): Promise<InitializeResponse>;
  untilUpdate(predicate: (notification: SessionNotification) => boolean, description: string): Promise<SessionNotification>;
  stderr(): string;
  finish(): Promise<AcpExit>;
};

const PROTOCOL_VERSION = 1;

export const startAcpClient = (home: E2eHome, options: AcpClientOptions = {}): AcpClient => {
  const child = spawn(process.execPath, [CLI_BUNDLE, 'acp'], { cwd: home.project, env: cliEnv(home), stdio: ['pipe', 'pipe', 'pipe'] });
  registerE2eCleanup(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const updates: SessionNotification[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const elicitationRequests: CreateElicitationRequest[] = [];
  const wire: string[] = [];
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<AcpExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let pending = '';
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        wire.push(...lines);
        controller.enqueue(new Uint8Array(chunk));
      });
      child.stdout.once('end', () => controller.close());
    },
  });

  const app = client({ name: 'momonga-e2e' })
    .onRequest('session/request_permission', async ({ params }) => {
      permissionRequests.push(params);
      if (options.permission === undefined) throw new Error('the test did not expect a permission request');
      return options.permission(params);
    })
    .onRequest('elicitation/create', async ({ params }) => {
      elicitationRequests.push(params);
      if (options.elicitation === undefined) throw new Error('the test did not expect an elicitation request');
      return options.elicitation(params);
    })
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    });
  const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), input));

  return {
    agent: connection.agent,
    updates,
    permissionRequests,
    elicitationRequests,
    wire,
    initialize: () =>
      connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: options.capabilities ?? {},
        clientInfo: { name: 'momonga-e2e', version: '0.0.0' },
      }),
    untilUpdate: (predicate, description) =>
      until(() => updates.find(predicate), { deadlineMs: E2E_RUN_COMPLETED_BOUND_MS, description }),
    stderr: () => stderr,
    finish: async () => {
      child.stdin.end();
      return withinBound(exited, E2E_RUN_COMPLETED_BOUND_MS, 'momonga acp to exit after its input closed');
    },
  };
};

export const updatesOf = (updates: readonly SessionNotification[], kind: SessionNotification['update']['sessionUpdate']): SessionNotification['update'][] =>
  updates.map((notification) => notification.update).filter((update) => update.sessionUpdate === kind);
