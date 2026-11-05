export const MAX_JSON_DEPTH = 128;

export class JsonDepthError extends Error {
  readonly maxDepth = MAX_JSON_DEPTH;

  constructor() {
    super(`JSON depth exceeds the limit of ${MAX_JSON_DEPTH}`);
    this.name = 'JsonDepthError';
  }
}

type Frame = { readonly container: object; readonly keys: readonly string[]; next: number };

const frameOf = (container: object): Frame => ({ container, keys: Object.keys(container), next: 0 });

export const checkJsonDepth = (value: unknown): void => {
  if (typeof value !== 'object' || value === null) return;
  const stack: Frame[] = [frameOf(value)];
  const path = new Set<object>([value]);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    const key = frame.keys[frame.next];
    if (key === undefined) {
      path.delete(frame.container);
      stack.pop();
      continue;
    }
    frame.next += 1;
    const child: unknown = (frame.container as Record<string, unknown>)[key];
    if (typeof child !== 'object' || child === null || path.has(child)) continue;
    if (stack.length >= MAX_JSON_DEPTH) throw new JsonDepthError();
    path.add(child);
    stack.push(frameOf(child));
  }
};

export const parseOutsideJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  checkJsonDepth(value);
  return value;
};
