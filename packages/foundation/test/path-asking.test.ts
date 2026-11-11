import { describe, expect, it } from 'vitest';
import { answeredLater, answeredNow, askedPaths, createPathResolver, createSyncPathResolver } from '@momonga/foundation';
import type { PathAsking, PathResolver, SyncPathResolver } from '@momonga/foundation';

const refusing = (): never => {
  throw new Error('this question was not expected');
};

const syncPathsWith = (answers: Partial<SyncPathResolver>): SyncPathResolver => ({ ...createSyncPathResolver({ stat: refusing, lstat: refusing, readlink: refusing, realpath: refusing, list: refusing, names: refusing }), ...answers });

const laterPathsWith = (answers: Partial<PathResolver>, signal: AbortSignal): PathResolver => ({
  ...createPathResolver({ stat: refusing, lstat: refusing, readlink: refusing, realpath: refusing, openDirectory: refusing, access: refusing }, signal),
  ...answers,
});

function* insideReal(directory: string, candidate: string): PathAsking<string> {
  let real: string;
  try {
    real = yield* askedPaths.realPath(candidate);
  } catch (error) {
    return `unresolved: ${(error as Error).message}`;
  }
  return (yield* askedPaths.comparableContains(directory, real)) ? `inside ${real}` : `outside ${real}`;
}

describe('one algorithm that asks about paths, answered now or later', () => {
  it('answers each question from the synchronous resolver, in the order asked', () => {
    const asked: string[] = [];
    const paths = syncPathsWith({
      realPath: (target) => {
        asked.push(`realPath ${target}`);
        return `/real${target}`;
      },
      comparableContains: (directory, candidate) => {
        asked.push(`contains ${directory} ${candidate}`);
        return true;
      },
    });
    expect(answeredNow(insideReal('/real', '/a'), paths)).toBe('inside /real/a');
    expect(asked).toEqual(['realPath /a', 'contains /real /real/a']);
  });

  it('gives the same answer from the asynchronous resolver', async () => {
    const signal = new AbortController().signal;
    const paths = laterPathsWith({ realPath: async (target) => `/real${target}`, comparableContains: async () => false }, signal);
    await expect(answeredLater(insideReal('/real', '/a'), paths, signal)).resolves.toBe('outside /real/a');
  });

  it('throws a failed answer into the algorithm at the question, for both drivers', async () => {
    const failure = new Error('ELOOP');
    const signal = new AbortController().signal;
    expect(
      answeredNow(
        insideReal('/real', '/a'),
        syncPathsWith({
          realPath: () => {
            throw failure;
          },
        }),
      ),
    ).toBe('unresolved: ELOOP');
    await expect(answeredLater(insideReal('/real', '/a'), laterPathsWith({ realPath: () => Promise.reject(failure) }, signal), signal)).resolves.toBe('unresolved: ELOOP');
  });

  it('ends with the reason of the asker when its signal aborted, without letting the algorithm take the abort for an answer', async () => {
    const controller = new AbortController();
    const reason = new Error('the asker left');
    const paths = laterPathsWith(
      {
        realPath: () => {
          controller.abort(reason);
          return Promise.reject(reason);
        },
      },
      controller.signal,
    );
    await expect(answeredLater(insideReal('/real', '/a'), paths, controller.signal)).rejects.toBe(reason);
  });

  it('lets a timer fire while a question of the asynchronous resolver stays unanswered', async () => {
    const controller = new AbortController();
    const reason = new Error('stalled long enough');
    const paths = laterPathsWith({ realPath: () => new Promise<string>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })) }, controller.signal);
    const pending = answeredLater(insideReal('/real', '/a'), paths, controller.signal);
    const fired = await new Promise<string>((resolve) => setImmediate(() => resolve('the event loop turned')));
    expect(fired).toBe('the event loop turned');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
