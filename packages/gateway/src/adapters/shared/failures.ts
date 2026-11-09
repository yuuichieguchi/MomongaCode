import type { ErrorType } from '@momonga/protocol';

export const CONTEXT_WINDOW_EXCEEDED = 'context_window_exceeded';
export const GUARDRAIL_VIOLATION = 'guardrail_violation';
export const UNSUPPORTED_REQUEST = 'unsupported_request';

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

export class UpstreamStall extends StreamFailure {
  constructor(code: string, message: string) {
    super(code, 'server_error', message);
    this.name = 'UpstreamStall';
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

export { UnsupportedInputError } from '../../core/unsupported-input.ts';

export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly upstreamCode: string | null;
  readonly upstreamMessage: string;
  readonly retryAfterMs: number | undefined;
  readonly guardrail: boolean;
  readonly contextOverflow: boolean;
  readonly unsupported: boolean;
  readonly retryHint: boolean | undefined;

  constructor(
    status: number,
    upstreamCode: string | null,
    upstreamMessage: string,
    retryAfterMs: number | undefined,
    guardrail: boolean,
    retryHint?: boolean,
    contextOverflow = false,
    unsupported = false,
  ) {
    super(`the upstream responded with HTTP ${status}: ${upstreamMessage}`);
    this.name = 'UpstreamHttpError';
    this.status = status;
    this.upstreamCode = upstreamCode;
    this.upstreamMessage = upstreamMessage;
    this.retryAfterMs = retryAfterMs;
    this.guardrail = guardrail;
    this.contextOverflow = contextOverflow;
    this.unsupported = unsupported;
    this.retryHint = retryHint;
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

export class TargetNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetNotReadyError';
  }
}

export class PreconditionFailedError extends Error {
  readonly detail: string | undefined;
  readonly remediation: string | undefined;

  constructor(message: string, detail: string | undefined, remediation: string | undefined) {
    super(message);
    this.name = 'PreconditionFailedError';
    this.detail = detail;
    this.remediation = remediation;
  }
}
