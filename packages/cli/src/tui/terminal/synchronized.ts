export const BEGIN_SYNCHRONIZED_UPDATE = '\u001b[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001b[?2026l';

const isSynchronizedUpdate = (chunk: unknown): boolean => chunk === BEGIN_SYNCHRONIZED_UPDATE || chunk === END_SYNCHRONIZED_UPDATE;

export const synchronizedFramesOf = (stdout: NodeJS.WriteStream, reported: () => boolean): NodeJS.WriteStream =>
  new Proxy(stdout, {
    get: (target, property) => {
      if (property === 'write') return (chunk: unknown, ...rest: unknown[]): boolean => (isSynchronizedUpdate(chunk) && !reported() ? true : Reflect.apply(target.write, target, [chunk, ...rest]) as boolean);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
