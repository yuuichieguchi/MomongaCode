import type { TextStream } from './process-contract.ts';

export type StandardStream = 'stdout' | 'stderr';

export type StandardStreamObserver = {
  closed(stream: StandardStream, error: NodeJS.ErrnoException): void;
  failed(stream: StandardStream, error: NodeJS.ErrnoException): void;
};

export type GuardedStandardStreams = {
  stdout: TextStream;
  stderr: TextStream;
  isClosed(stream: StandardStream): boolean;
  observe(observer: StandardStreamObserver): void;
};

const BROKEN_PIPE = 'EPIPE';

const UNOBSERVED: StandardStreamObserver = {
  closed: () => undefined,
  failed: (_stream, error) => {
    throw error;
  },
};

export const guardStandardStreams = (host: Pick<NodeJS.Process, 'stdout' | 'stderr'>): GuardedStandardStreams => {
  const closed = new Set<StandardStream>();
  let observer = UNOBSERVED;
  const onError = (stream: StandardStream, error: NodeJS.ErrnoException): void => {
    if (error.code !== BROKEN_PIPE) {
      observer.failed(stream, error);
      return;
    }
    if (closed.has(stream)) return;
    closed.add(stream);
    observer.closed(stream, error);
  };
  host.stdout.on('error', (error: NodeJS.ErrnoException) => onError('stdout', error));
  host.stderr.on('error', (error: NodeJS.ErrnoException) => onError('stderr', error));
  const guarded = (stream: StandardStream, target: NodeJS.WriteStream): TextStream => ({
    write: (chunk) => (closed.has(stream) ? true : target.write(chunk)),
  });
  return {
    stdout: guarded('stdout', host.stdout),
    stderr: guarded('stderr', host.stderr),
    isClosed: (stream) => closed.has(stream),
    observe: (next) => {
      observer = next;
    },
  };
};
