import { hostname } from 'node:os';

export const daemonBanner = (): string => `daemon module loaded pid-is-number=${typeof process.pid === 'number'} host-is-string=${typeof hostname() === 'string'}`;
