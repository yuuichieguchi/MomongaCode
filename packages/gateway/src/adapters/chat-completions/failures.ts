import type { ErrorType } from '@momonga/protocol';

export class StreamFailure extends Error {
  readonly code: string;
  readonly errorType: ErrorType;

  constructor(code: string, errorType: ErrorType, message: string) {
    super(message);
    this.name = 'StreamFailure';
    this.code = code;
    this.errorType = errorType;
  }
}

export class UpstreamProtocolError extends StreamFailure {
  constructor(message: string) {
    super('upstream_protocol_error', 'model_error', message);
    this.name = 'UpstreamProtocolError';
  }
}

export class MalformedOutputError extends StreamFailure {
  constructor(message: string) {
    super('malformed_output', 'model_error', message);
    this.name = 'MalformedOutputError';
  }
}

export class UnsupportedInputError extends Error {
  readonly code: string;
  readonly param: string | null;

  constructor(code: string, message: string, param: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedInputError';
    this.code = code;
    this.param = param;
  }
}

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly upstreamCode: string | null;
  readonly upstreamMessage: string;
  readonly retryAfterMs: number | undefined;
  readonly guardrail: boolean;

  constructor(
    status: number,
    upstreamCode: string | null,
    upstreamMessage: string,
    retryAfterMs: number | undefined,
    guardrail: boolean,
  ) {
    super(`the upstream responded with HTTP ${status}: ${upstreamMessage}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.upstreamCode = upstreamCode;
    this.upstreamMessage = upstreamMessage;
    this.retryAfterMs = retryAfterMs;
    this.guardrail = guardrail;
  }
}

export type CompactionReplyCode = 'compaction_summary_too_long' | 'compaction_invalid_reply' | 'content_filter';

export class CompactionReplyError extends Error {
  readonly code: CompactionReplyCode;
  readonly retryable: boolean;

  constructor(code: CompactionReplyCode, retryable: boolean, message: string) {
    super(message);
    this.name = 'CompactionReplyError';
    this.code = code;
    this.retryable = retryable;
  }
}
