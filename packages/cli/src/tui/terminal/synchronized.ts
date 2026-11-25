export const BEGIN_SYNCHRONIZED_UPDATE = '\u001b[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001b[?2026l';
export const CLEAR_BEFORE_FIRST_FRAME = '\u001b[?25l\u001b[H\u001b[J';

export type SynchronizedFramesOptions = { readonly clearBeforeFirstFrame?: boolean };

const isSynchronizedUpdate = (chunk: unknown): boolean => chunk === BEGIN_SYNCHRONIZED_UPDATE || chunk === END_SYNCHRONIZED_UPDATE;

export const synchronizedFramesOf = (stdout: NodeJS.WriteStream, reported: () => boolean, options?: SynchronizedFramesOptions): NodeJS.WriteStream => {
  let pendingClear = options?.clearBeforeFirstFrame === true;
  return new Proxy(stdout, {
    get: (target, property) => {
      if (property === 'write') {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          if (isSynchronizedUpdate(chunk)) return !reported() ? true : (Reflect.apply(target.write, target, [chunk, ...rest]) as boolean);
          if (pendingClear) {
            pendingClear = false;
            if (typeof chunk === 'string') return Reflect.apply(target.write, target, [`${CLEAR_BEFORE_FIRST_FRAME}${chunk}`, ...rest]) as boolean;
            Reflect.apply(target.write, target, [CLEAR_BEFORE_FIRST_FRAME]);
          }
          return Reflect.apply(target.write, target, [chunk, ...rest]) as boolean;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};
