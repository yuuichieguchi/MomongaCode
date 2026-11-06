export const TRANSIENT_REQUEST_STATUSES: readonly number[] = [408, 409];

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_FROM = 500;

export const parseShouldRetry = (header: string | undefined): boolean | undefined => {
  if (header === 'true') return true;
  if (header === 'false') return false;
  return undefined;
};

export const isRetryableHttp = (status: number, shouldRetry: boolean | undefined): boolean =>
  shouldRetry ?? (TRANSIENT_REQUEST_STATUSES.includes(status) || status === TOO_MANY_REQUESTS || status >= SERVER_ERROR_FROM);
