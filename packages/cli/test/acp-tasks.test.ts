import { describe, expect, it } from 'vitest';
import { createOrderedQueue, createTaskGroup } from '../src/acp/tasks.ts';

describe('createOrderedQueue', () => {
  it('runs the tasks one after another in the order they were queued', async () => {
    const queue = createOrderedQueue();
    const log: string[] = [];
    const gate = Promise.withResolvers<void>();
    queue.enqueue(async () => {
      log.push('first start');
      await gate.promise;
      log.push('first end');
    });
    queue.enqueue(async () => {
      log.push('second');
    });

    expect(log).toEqual([]);
    await Promise.resolve();
    gate.resolve();
    await queue.settled();

    expect(log).toEqual(['first start', 'first end', 'second']);
  });

  it('settles at once when nothing was queued', async () => {
    await createOrderedQueue().settled();
  });

  it('rethrows the first failure at settled, skips the tasks queued after it and keeps failing', async () => {
    const queue = createOrderedQueue();
    const log: string[] = [];
    queue.enqueue(async () => {
      log.push('before');
    });
    queue.enqueue(async () => {
      throw new Error('the write failed');
    });
    queue.enqueue(async () => {
      log.push('after');
    });

    await expect(queue.settled()).rejects.toThrow('the write failed');
    await expect(queue.settled()).rejects.toThrow('the write failed');
    expect(log).toEqual(['before']);
  });
});

describe('createTaskGroup', () => {
  it('settles after every task has finished, including the ones added while waiting', async () => {
    const failures: unknown[] = [];
    const group = createTaskGroup((error) => failures.push(error));
    const log: string[] = [];
    const gate = Promise.withResolvers<void>();
    group.run(async () => {
      await gate.promise;
      log.push('first');
      group.run(async () => {
        log.push('nested');
      });
    });

    const settled = group.settled();
    gate.resolve();
    await settled;

    expect(log).toEqual(['first', 'nested']);
    expect(failures).toEqual([]);
  });

  it('reports the first failure once, rethrows it at settled and lets the other tasks finish', async () => {
    const failures: unknown[] = [];
    const group = createTaskGroup((error) => failures.push(error));
    const first = new Error('first failure');
    const log: string[] = [];
    group.run(async () => {
      throw first;
    });
    group.run(async () => {
      throw new Error('second failure');
    });
    group.run(async () => {
      log.push('still ran');
    });

    await expect(group.settled()).rejects.toBe(first);
    expect(failures).toEqual([first]);
    expect(log).toEqual(['still ran']);
  });

  it('settles at once when no task was started', async () => {
    await createTaskGroup(() => undefined).settled();
  });
});
