export const UPDATE_ERROR_CODES = [
  'no_update_source',
  'invalid_update_source',
  'not_single_executable',
  'unsupported_platform',
  'update_in_progress',
  'release_lookup_failed',
  'release_malformed',
  'version_malformed',
  'downgrade_refused',
  'checksums_unavailable',
  'checksum_entry_missing',
  'download_failed',
  'checksum_mismatch',
  'signature_rejected',
  'candidate_unusable',
  'daemon_restart_failed',
] as const;

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

export type UpdateErrorDetails = { detail?: string; remediation?: string; cause?: unknown };

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;
  readonly detail: string | undefined;
  readonly remediation: string | undefined;

  constructor(code: UpdateErrorCode, message: string, details: UpdateErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'UpdateError';
    this.code = code;
    this.detail = details.detail;
    this.remediation = details.remediation;
  }
}
