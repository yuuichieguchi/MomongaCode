export class ClaimLeftFileError extends Error {
  readonly file: string;
  readonly code: string | undefined;

  constructor(file: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ClaimLeftFileError';
    this.file = file;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
    this.code = typeof code === 'string' ? code : undefined;
  }
}
