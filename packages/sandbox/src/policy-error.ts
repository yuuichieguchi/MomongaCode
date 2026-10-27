import type { FileRuleProvenance, UnresolvableReason } from '@momonga/foundation';

export type SandboxPolicyErrorCode =
  | 'read_allowed_not_inside_denied'
  | 'read_allowed_contains_denied'
  | 'session_tmp_not_read_allowed'
  | 'session_tmp_write_denied'
  | 'read_allowed_inside_owned_root'
  | 'entry_not_absolute'
  | 'writable_root_not_absolute'
  | 'writable_root_missing'
  | 'file_rules_stale'
  | 'guard_path_unresolvable';

export class SandboxPolicyError extends Error {
  readonly code: SandboxPolicyErrorCode;
  readonly path: string | undefined;
  readonly provenance: FileRuleProvenance | undefined;
  readonly reason: UnresolvableReason | undefined;

  constructor(code: SandboxPolicyErrorCode, message: string, detail: { path?: string; provenance?: FileRuleProvenance; reason?: UnresolvableReason; cause?: unknown } = {}) {
    super(message, 'cause' in detail ? { cause: detail.cause } : undefined);
    this.name = 'SandboxPolicyError';
    this.code = code;
    this.path = detail.path;
    this.provenance = detail.provenance;
    this.reason = detail.reason;
  }
}
