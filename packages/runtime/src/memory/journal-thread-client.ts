import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { JournalThreadError, blobDirectoryOf } from '@momonga/store';
import type { ContributionMeasured, ContributionPreparer, EvidenceReply, FidelityReply, RecordedCheck, RecordedHash, ReflectionInputReply, VerdictFact, VerdictReply } from '@momonga/store';
import { JOURNAL_THREAD_CODE } from './journal-thread-code.generated.ts';

export type JournalThreadTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type JournalThreadOptions = {
  readonly databasePath: string;
  readonly identity: { readonly dev: number; readonly ino: number };
  readonly silenceLimitMs: number;
  readonly code?: string;
  readonly timers?: JournalThreadTimers;
};

export type JournalThreadReply = Readonly<Record<string, unknown>>;

export type JournalThreadClient = ContributionPreparer & {
  readonly identity: { readonly dev: number; readonly ino: number };
  request(request: { readonly kind: string } & Readonly<Record<string, unknown>>): Promise<JournalThreadReply>;
  ping(): Promise<{ readonly threadId: number }>;
  close(): Promise<void>;
};

type Pending = { readonly resolve: (reply: JournalThreadReply) => void; readonly reject: (error: JournalThreadError) => void };

type Live = {
  readonly worker: Worker;
  readonly port: MessagePort;
  readonly pending: Map<number, Pending>;
  readonly ready: Promise<Live>;
  readonly settleReady: { resolve: (live: Live) => void; reject: (error: JournalThreadError) => void };
  handshaking: boolean;
  dead: boolean;
  timer: unknown;
  armed: boolean;
};

const realTimers: JournalThreadTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

type ContributionItems = NonNullable<ContributionMeasured['contribution']>['items'];

const isContributionItem = (item: unknown): boolean =>
  isRecord(item) && typeof item['kind'] === 'string' && typeof item['id'] === 'string' && typeof item['contributed'] === 'boolean';

const measuredOf = (reply: JournalThreadReply): ContributionMeasured => {
  const { lastSeq, items } = reply;
  if (typeof lastSeq !== 'number') throw new JournalThreadError('journal thread contribution reply carries no numeric lastSeq');
  if (items === undefined) return { lastSeq };
  if (!Array.isArray(items) || !items.every(isContributionItem)) throw new JournalThreadError('journal thread contribution reply carries malformed items');
  return { lastSeq, contribution: { type: 'context.contribution', items: items as ContributionItems } };
};

const lastSeqOf = (reply: JournalThreadReply, kind: string): number => {
  const { lastSeq } = reply;
  if (typeof lastSeq !== 'number') throw new JournalThreadError(`journal thread ${kind} reply carries no numeric lastSeq`);
  return lastSeq;
};

const isVerdictFact = (fact: unknown): fact is VerdictFact =>
  isRecord(fact) &&
  typeof fact['command'] === 'string' &&
  typeof fact['text'] === 'string' &&
  fact['kind'] === 'procedure' &&
  isRecord(fact['check']) &&
  typeof fact['check']['callId'] === 'string' &&
  typeof fact['check']['seq'] === 'number' &&
  Array.isArray(fact['manifestPaths']) &&
  fact['manifestPaths'].every((entry) => typeof entry === 'string');

const verdictOf = (reply: JournalThreadReply): VerdictReply => {
  const { verified, facts } = reply;
  if (typeof verified !== 'boolean') throw new JournalThreadError('journal thread verdict reply carries no boolean verified');
  if (!Array.isArray(facts) || !facts.every(isVerdictFact)) throw new JournalThreadError('journal thread verdict reply carries malformed facts');
  return { lastSeq: lastSeqOf(reply, 'verdict'), verified, facts };
};

const isRecordedHash = (entry: unknown): entry is RecordedHash => isRecord(entry) && typeof entry['sha256'] === 'string' && typeof entry['seq'] === 'number';

const isRecordedCheck = (entry: unknown): entry is RecordedCheck =>
  isRecord(entry) && typeof entry['callId'] === 'string' && typeof entry['seq'] === 'number' && typeof entry['command'] === 'string' && typeof entry['exitCode'] === 'number';

const evidenceOf = (reply: JournalThreadReply): EvidenceReply => {
  const { recorded, check } = reply;
  if (!Array.isArray(recorded) || !recorded.every((entry) => entry === null || isRecordedHash(entry))) throw new JournalThreadError('journal thread evidence reply carries malformed recorded hashes');
  if (check !== null && !isRecordedCheck(check)) throw new JournalThreadError('journal thread evidence reply carries a malformed check');
  return { lastSeq: lastSeqOf(reply, 'evidence'), recorded, check };
};

const reflectionInputOf = (reply: JournalThreadReply): ReflectionInputReply => {
  const { input } = reply;
  if (typeof input !== 'string') throw new JournalThreadError('journal thread reflection_input reply carries no input text');
  return { lastSeq: lastSeqOf(reply, 'reflection_input'), input };
};

const isUnreadable = (entry: unknown): entry is FidelityReply['unreadable'][number] => isRecord(entry) && typeof entry['handle'] === 'string' && typeof entry['reason'] === 'string';

const fidelityOf = (reply: JournalThreadReply): FidelityReply => {
  const { attested, unreadable } = reply;
  if (!Array.isArray(attested) || !attested.every((token) => typeof token === 'string')) throw new JournalThreadError('journal thread fidelity reply carries malformed attested tokens');
  if (!Array.isArray(unreadable) || !unreadable.every(isUnreadable)) throw new JournalThreadError('journal thread fidelity reply carries malformed unreadable blobs');
  return { lastSeq: lastSeqOf(reply, 'fidelity'), attested, unreadable };
};

export const startJournalThread = async (options: JournalThreadOptions): Promise<JournalThreadClient> => {
  const { databasePath, identity, silenceLimitMs, code = JOURNAL_THREAD_CODE, timers = realTimers } = options;
  const terminations = new Set<Promise<void>>();
  let terminationFailure: { readonly error: unknown } | null = null;
  let current: Live | null = null;
  let nextId = 1;
  let closePromise: Promise<void> | null = null;

  const disarm = (live: Live): void => {
    if (!live.armed) return;
    timers.clearTimeout(live.timer);
    live.armed = false;
  };

  const terminate = (live: Live): void => {
    const termination: Promise<void> = live.worker.terminate().then(
      () => undefined,
      (error: unknown) => {
        terminationFailure ??= { error };
      },
    ).finally(() => terminations.delete(termination));
    terminations.add(termination);
  };

  const fail = (live: Live, error: JournalThreadError): void => {
    if (live.dead) return;
    live.dead = true;
    disarm(live);
    if (current === live) current = null;
    const waiting = [...live.pending.values()];
    live.pending.clear();
    live.port.close();
    terminate(live);
    if (live.handshaking) {
      live.handshaking = false;
      live.settleReady.reject(error);
    }
    for (const request of waiting) request.reject(error);
  };

  const arm = (live: Live): void => {
    disarm(live);
    if (live.dead || (!live.handshaking && live.pending.size === 0)) return;
    live.armed = true;
    live.timer = timers.setTimeout(() => onSilence(live), silenceLimitMs);
  };

  const onMessage = (live: Live, message: unknown): void => {
    if (live.dead) return;
    if (!isRecord(message)) {
      fail(live, new JournalThreadError('journal thread sent a message that is not an object'));
      return;
    }
    if (live.handshaking) {
      if (message['ready'] !== true) {
        fail(live, new JournalThreadError('journal thread sent a message before it was ready'));
        return;
      }
      if (message['dev'] !== identity.dev || message['ino'] !== identity.ino) {
        fail(live, new JournalThreadError(`journal thread opened a different database file: expected dev ${identity.dev} ino ${identity.ino}, got dev ${String(message['dev'])} ino ${String(message['ino'])}`));
        return;
      }
      live.handshaking = false;
      live.settleReady.resolve(live);
      arm(live);
      return;
    }
    const id = message['id'];
    const request = typeof id === 'number' ? live.pending.get(id) : undefined;
    if (request === undefined || typeof id !== 'number') {
      fail(live, new JournalThreadError(`journal thread sent a message that matches no request: ${JSON.stringify(message)}`));
      return;
    }
    if (message['ok'] === undefined && 'progress' in message) {
      arm(live);
      return;
    }
    live.pending.delete(id);
    arm(live);
    if (message['ok'] === true) {
      const { id: _id, ok: _ok, ...reply } = message;
      request.resolve(reply);
      return;
    }
    const cause = message['error'];
    const name = isRecord(cause) ? String(cause['name']) : 'Error';
    const text = isRecord(cause) ? String(cause['message']) : String(cause);
    request.reject(new JournalThreadError(`journal thread request failed: ${text}`, { cause: { name, message: text } }));
  };

  const drain = (live: Live): boolean => {
    let received = false;
    for (let item = receiveMessageOnPort(live.port); item !== undefined; item = receiveMessageOnPort(live.port)) {
      received = true;
      onMessage(live, item.message);
      if (live.dead) break;
    }
    return received;
  };

  const onSilence = (live: Live): void => {
    live.armed = false;
    if (live.dead) return;
    if (drain(live)) {
      if (!live.dead && !live.armed) arm(live);
      return;
    }
    fail(live, new JournalThreadError(`journal thread was silent for ${silenceLimitMs} ms`));
  };

  const spawn = (): Live => {
    const { port1, port2 } = new MessageChannel();
    let worker: Worker;
    try {
      worker = new Worker(code, { eval: true, workerData: { databasePath, blobsDir: blobDirectoryOf(databasePath), port: port2 }, transferList: [port2] });
    } catch (error) {
      port1.close();
      port2.close();
      throw new JournalThreadError('journal thread could not be spawned', { cause: error });
    }
    const settleReady = {} as Live['settleReady'];
    const ready = new Promise<Live>((resolve, reject) => {
      settleReady.resolve = resolve;
      settleReady.reject = reject;
    });
    const live: Live = { worker, port: port1, pending: new Map(), ready, settleReady, handshaking: true, dead: false, timer: undefined, armed: false };
    current = live;
    port1.on('message', (message: unknown) => onMessage(live, message));
    worker.on('error', (error: Error) => {
      drain(live);
      fail(live, new JournalThreadError(`journal thread failed: ${error.message}`, { cause: error }));
    });
    worker.on('exit', (exitCode: number) => {
      drain(live);
      fail(live, new JournalThreadError(`journal thread exited with code ${exitCode}`));
    });
    arm(live);
    return live;
  };

  const liveThread = (): Promise<Live> => {
    if (current === null) current = spawn();
    return current.ready;
  };

  const request: JournalThreadClient['request'] = async (body) => {
    if (closePromise !== null) throw new JournalThreadError('journal thread client is closed');
    const live = await liveThread();
    if (live.dead) throw new JournalThreadError('journal thread died before the request was sent');
    return new Promise<JournalThreadReply>((resolve, reject) => {
      const id = nextId++;
      live.pending.set(id, { resolve, reject });
      arm(live);
      try {
        live.worker.postMessage({ ...body, id });
      } catch (error) {
        live.pending.delete(id);
        arm(live);
        reject(new JournalThreadError('journal thread request could not be sent', { cause: error }));
      }
    });
  };

  const ping: JournalThreadClient['ping'] = async () => {
    const reply = await request({ kind: 'ping' });
    const reportedThreadId = reply['threadId'];
    if (typeof reportedThreadId !== 'number') throw new JournalThreadError('journal thread ping reply carries no numeric threadId');
    return { threadId: reportedThreadId };
  };

  const measure: JournalThreadClient['measure'] = async ({ runId, leading }) => {
    const reply = await request({ kind: 'contribution', runId, leading });
    return measuredOf(reply);
  };

  const verdict: JournalThreadClient['verdict'] = async ({ runId, commands, manifests }) => verdictOf(await request({ kind: 'verdict', runId, commands, manifests }));

  const evidence: JournalThreadClient['evidence'] = async ({ runId, paths, verificationCommands, onlyCommand }) =>
    evidenceOf(await request({ kind: 'evidence', runId, paths, verificationCommands, ...(onlyCommand === undefined ? {} : { onlyCommand }) }));

  const reflectionInput: JournalThreadClient['reflectionInput'] = async ({ runId, project, capabilities }) =>
    reflectionInputOf(await request({ kind: 'reflection_input', runId, project, capabilities }));

  const fidelity: JournalThreadClient['fidelity'] = async ({ runId, throughEventSeq, cwd, tokens }) =>
    fidelityOf(await request({ kind: 'fidelity', runId, throughEventSeq, cwd, tokens }));

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (current !== null) fail(current, new JournalThreadError('journal thread client was closed'));
      await Promise.all([...terminations]);
      if (terminationFailure !== null) throw terminationFailure.error;
    })();
    return closePromise;
  };

  await liveThread();
  return { identity, request, ping, measure, verdict, evidence, reflectionInput, fidelity, close };
};
