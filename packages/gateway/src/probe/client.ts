import { Deadline, createUdsClient } from '@momonga/foundation';

export interface HttpResult {
  status: number;
  text: string;
}

export interface ProbeClient {
  get(path: string): Promise<HttpResult>;
  post(path: string, body: unknown): Promise<HttpResult>;
  stream(path: string, body: unknown): Promise<{ status: number; chunks: AsyncIterable<Uint8Array> }>;
  close(): Promise<void>;
}

export class ProbeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(method: string, path: string, timeoutMs: number) {
    super(`Probe request ${method} ${path} timed out after ${timeoutMs} ms`);
    this.name = 'ProbeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export const createProbeClient = (
  socketPath: string,
  signal: AbortSignal | undefined,
  stepTimeoutMs: number,
): ProbeClient => {
  const uds = createUdsClient(socketPath);

  const withTimeout = async <T>(
    method: string,
    path: string,
    perform: (requestSignal: AbortSignal, timedOut: () => boolean, dispose: () => void) => Promise<T>,
    streaming = false,
  ): Promise<T> => {
    const deadline = Deadline.after(stepTimeoutMs);
    const requestSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    const timedOut = (): boolean => deadline.expired && signal?.aborted !== true;
    try {
      return await perform(requestSignal, timedOut, () => deadline.dispose());
    } catch (error) {
      deadline.dispose();
      if (timedOut()) throw new ProbeTimeoutError(method, path, stepTimeoutMs);
      throw error;
    } finally {
      if (!streaming) deadline.dispose();
    }
  };

  const jsonPost = (path: string, body: unknown, requestSignal: AbortSignal) =>
    uds.request({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal,
    });

  return {
    get: (path) =>
      withTimeout('GET', path, async (requestSignal) => {
        const response = await uds.request({ method: 'GET', path, signal: requestSignal });
        return { status: response.status, text: await response.text() };
      }),
    post: (path, body) =>
      withTimeout('POST', path, async (requestSignal) => {
        const response = await jsonPost(path, body, requestSignal);
        return { status: response.status, text: await response.text() };
      }),
    stream: (path, body) =>
      withTimeout(
        'POST',
        path,
        async (requestSignal, timedOut, dispose) => {
          const response = await jsonPost(path, body, requestSignal);
          async function* chunks(): AsyncGenerator<Uint8Array> {
            try {
              yield* response.body;
            } catch (error) {
              if (timedOut()) throw new ProbeTimeoutError('POST', path, stepTimeoutMs);
              throw error;
            } finally {
              dispose();
            }
          }
          return { status: response.status, chunks: chunks() };
        },
        true,
      ),
    close: () => uds.close(),
  };
};
