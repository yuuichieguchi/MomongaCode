import { nodeEntryIo, runDaemonEntry } from '../../src/index.ts';
import { epipeDaemon } from './epipe-daemon-definition.ts';

const REGISTRATIONS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

const withoutErrorListeners = <T extends object>(stream: T): T =>
  new Proxy(stream, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property === 'string' && REGISTRATIONS.has(property)) {
        return (event: string | symbol, listener: (...args: unknown[]) => void) => {
          if (event === 'error') return target;
          return (value as (event: string | symbol, listener: (...args: unknown[]) => void) => unknown).call(target, event, listener);
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

const stdout = withoutErrorListeners(process.stdout);
const stderr = withoutErrorListeners(process.stderr);

const host = new Proxy(process, {
  get(target, property) {
    if (property === 'stdout') return stdout;
    if (property === 'stderr') return stderr;
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
  set(target, property, value) {
    return Reflect.set(target, property, value, target);
  },
});

await runDaemonEntry(nodeEntryIo(host), epipeDaemon);
