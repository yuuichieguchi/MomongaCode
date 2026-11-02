const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isLoopbackHost = (host: string): boolean => {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const match = IPV4_LOOPBACK.exec(host);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
};

export type TransportUrlProblem = 'unparseable' | 'userinfo' | 'cleartext';

export const redactedUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<unparseable URL>';
  }
  return `${url.protocol}//${url.host}${url.pathname}`;
};

export const transportUrlProblem = (raw: string): TransportUrlProblem | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unparseable';
  }
  if (url.username !== '' || url.password !== '') return 'userinfo';
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  return secure ? undefined : 'cleartext';
};

export const transportUrlMessage = (what: string, raw: string, problem: TransportUrlProblem): string => {
  switch (problem) {
    case 'unparseable':
      return `${what} is not a valid URL`;
    case 'userinfo':
      return `${what} must not contain userinfo`;
    case 'cleartext':
      return `${what} ${redactedUrl(raw)} must use https: (http: is only allowed for loopback hosts)`;
  }
};
