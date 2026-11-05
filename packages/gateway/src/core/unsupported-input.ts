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
