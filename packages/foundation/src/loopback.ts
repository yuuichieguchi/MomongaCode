const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isLoopbackHost = (host: string): boolean => {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const match = IPV4_LOOPBACK.exec(host);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
};
