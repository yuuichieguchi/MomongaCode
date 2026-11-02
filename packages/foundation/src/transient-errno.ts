const TRANSIENT_ERRNO_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'EBUSY', 'ENOMEM', 'EINTR', 'ETIMEDOUT', 'ENOSPC', 'EDQUOT']);

export const isTransientErrnoCode = (code: string): boolean => TRANSIENT_ERRNO_CODES.has(code);

export const isTransientErrno = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && isTransientErrnoCode(code);
};
