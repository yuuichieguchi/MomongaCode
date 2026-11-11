import type { CarryRefusal } from '@momonga/protocol';

export class UnsupportedInputError extends Error {
  readonly code: string;
  readonly param: string | null;

  constructor(code: string, message: string, param: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedInputError';
    this.code = code;
    this.param = param;
  }
}

export const carryRefusalOfRender = (render: () => unknown): CarryRefusal | undefined => {
  try {
    render();
    return undefined;
  } catch (error) {
    if (!(error instanceof UnsupportedInputError)) throw error;
    return { code: error.code, message: error.message, param: error.param };
  }
};
