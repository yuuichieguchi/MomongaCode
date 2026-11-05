export const MAX_JSON_DEPTH = 128;

export class JsonDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonDepthError';
  }
}

export const checkJsonDepth = (_value: unknown): void => {};

export const parseOutsideJson = (text: string): unknown => JSON.parse(text);
