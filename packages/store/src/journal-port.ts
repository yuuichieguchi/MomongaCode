export class StalePreparation extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`the contribution prepared for run ${runId} no longer covers its journal`);
    this.name = 'StalePreparation';
    this.runId = runId;
  }
}

export class JournalThreadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JournalThreadError';
  }
}

export class FactsRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FactsRefusedError';
  }
}
