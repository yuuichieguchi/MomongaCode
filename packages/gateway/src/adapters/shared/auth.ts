import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, ClassifiedError } from '@momonga/protocol';
import type { AuthSource } from '../../plan/auth-source.ts';
import { readTextLimited } from './body-reading.ts';
import type { CompletionResponse } from './http-client.ts';
import { MAX_ERROR_BODY_BYTES } from './limits.ts';

export type AdapterAuth = (target: AdapterTarget) => AuthSource;

const KEY_GENERATION = 0;
const UNAUTHORIZED = 401;

export const keyAuthSource =
  (readKey: (target: AdapterTarget, signal: AbortSignal) => Promise<string>): AdapterAuth =>
  (target) => ({
    read: async (signal) => ({ bearer: await readKey(target, signal), generation: KEY_GENERATION }),
    rejected: async () => 'unchanged',
    pause: async () => {},
    resume: async () => {},
    status: () => ({ state: 'active' }),
    health: () => ({ ok: true }),
  });

export const unauthenticatedSource: AdapterAuth = () => ({
  read: async () => ({ bearer: undefined, generation: KEY_GENERATION }),
  rejected: async () => 'unchanged',
  pause: async () => {},
  resume: async () => {},
  status: () => ({ state: 'active' }),
  health: () => ({ ok: true }),
});

export const sendAuthorized = async (
  auth: AuthSource,
  signal: AbortSignal,
  send: (bearer: string | undefined) => Promise<CompletionResponse>,
): Promise<CompletionResponse> => {
  const sent = await auth.read(signal);
  const response = await send(sent.bearer);
  if (response.status !== UNAUTHORIZED) return response;
  if ((await auth.rejected(sent.generation, signal)) !== 'renewed') return response;
  await readTextLimited(response.body, MAX_ERROR_BODY_BYTES);
  const renewed = await auth.read(signal);
  return send(renewed.bearer);
};

export const applyCredentialEffect = async (auth: AuthSource, classified: ClassifiedError, clock: Clock): Promise<void> => {
  if (classified.credential !== 'pause') return;
  const { code } = classified.error;
  if (code === null) throw new Error('a classification that pauses the credential carries no code');
  await auth.pause({ code, ...(classified.retryAfterMs === undefined ? {} : { untilMs: clock.now() + classified.retryAfterMs }) });
};
