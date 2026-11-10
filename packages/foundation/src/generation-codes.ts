export const GENERATION_RETIRED_CODE = 'generation_retired';

export const MOVED_CODE = 'moved';

export const GENERATION_RETIRED_STATUS = 503;

export class GenerationRetiredError extends Error {
  readonly code = GENERATION_RETIRED_CODE;
  readonly status = GENERATION_RETIRED_STATUS;

  constructor(message = 'this generation is retiring and takes no new call') {
    super(message);
    this.name = 'GenerationRetiredError';
  }
}
