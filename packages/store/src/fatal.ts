const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

const FATAL_PRIMARY_CODES: readonly number[] = [SQLITE_READONLY, SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_NOTADB];

export class StoreIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreIdentityError';
  }
}

export const isFatalStoreError = (error: unknown): boolean => {
  if (error instanceof StoreIdentityError) return true;
  if (!(error instanceof Error)) return false;
  const { errcode } = error as { errcode?: unknown };
  return typeof errcode === 'number' && FATAL_PRIMARY_CODES.includes(errcode & 0xff);
};

export const isStoreFullError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const { errcode } = error as { errcode?: unknown };
  return typeof errcode === 'number' && (errcode & 0xff) === SQLITE_FULL;
};
