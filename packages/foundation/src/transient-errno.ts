const TRANSIENT_ERRNO_CODES: ReadonlySet<string> = new Set(['EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'EBUSY', 'ENOMEM', 'EINTR', 'ETIMEDOUT', 'ENOSPC', 'EDQUOT']);

export const isTransientErrno = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && TRANSIENT_ERRNO_CODES.has(code);
};
