import { globalErrorHandler, loggingErrorHandler, setGlobalErrorHandler } from '@opentelemetry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOtelErrorHandler } from '@momonga/observability';
import { reportError } from '../src/errors.ts';

afterEach(() => {
  setGlobalErrorHandler(loggingErrorHandler());
  vi.restoreAllMocks();
});

describe('installOtelErrorHandler', () => {
  it('routes reportError to the installed handler without writing to stdout or stderr', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const handler = vi.fn();
    installOtelErrorHandler(handler);
    const error = new Error('x');
    reportError(error);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(error);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('wraps a non-Error input into an Error', () => {
    const handler = vi.fn();
    installOtelErrorHandler(handler);
    reportError('plain string');
    globalErrorHandler('from otel internals' as never);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const [received] of handler.mock.calls) expect(received).toBeInstanceOf(Error);
    expect((handler.mock.calls[0]?.[0] as Error).message).toBe('plain string');
    expect((handler.mock.calls[1]?.[0] as Error).message).toBe('from otel internals');
  });
});
