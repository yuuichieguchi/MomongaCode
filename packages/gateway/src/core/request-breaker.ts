import type { Clock } from '@momonga/foundation';

export const BREAKER_STATES = ['closed', 'open', 'half-open'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export const BREAKER_OUTCOMES = ['success', 'failure', 'neutral'] as const;
export type BreakerOutcome = (typeof BREAKER_OUTCOMES)[number];

export type BreakerArm = {
  readonly from: BreakerState;
  readonly outcome: BreakerOutcome;
  readonly holder: boolean;
  readonly to: readonly BreakerState[];
};

export const BREAKER_ARMS: readonly BreakerArm[] = [
  { from: 'closed', outcome: 'failure', holder: false, to: ['closed', 'open'] },
  { from: 'closed', outcome: 'success', holder: false, to: ['closed'] },
  { from: 'half-open', outcome: 'success', holder: false, to: ['closed'] },
  { from: 'half-open', outcome: 'failure', holder: true, to: ['open'] },
  { from: 'half-open', outcome: 'neutral', holder: true, to: ['half-open'] },
];

export const BREAKER_COOLDOWN = { from: 'open', to: 'half-open' } as const;

export type RequestToken = symbol;

export type TargetBreakerOptions = {
  failureThreshold: number;
  openMs: number;
  clock: Clock;
};

export class TargetBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly clock: Clock;
  private current: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trial: RequestToken | undefined;

  constructor(options: TargetBreakerOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new RangeError(`TargetBreaker: failureThreshold must be a positive integer, got ${options.failureThreshold}`);
    }
    if (!Number.isInteger(options.openMs) || options.openMs < 1) {
      throw new RangeError(`TargetBreaker: openMs must be a positive integer, got ${options.openMs}`);
    }
    this.failureThreshold = options.failureThreshold;
    this.openMs = options.openMs;
    this.clock = options.clock;
  }

  get state(): BreakerState {
    return this.current;
  }

  canPass(request: RequestToken): boolean {
    this.cool();
    return this.current === 'closed' || (this.current === 'half-open' && (this.trial === undefined || this.trial === request));
  }

  admit(request: RequestToken): void {
    this.cool();
    if (this.current === 'half-open' && this.trial === undefined) this.trial = request;
  }

  record(request: RequestToken, outcome: BreakerOutcome): void {
    this.cool();
    const arm = BREAKER_ARMS.find((candidate) => candidate.from === this.current && candidate.outcome === outcome && (!candidate.holder || this.trial === request));
    if (arm === undefined) return;
    switch (`${arm.from}/${arm.outcome}`) {
      case 'closed/failure':
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.failureThreshold) this.trip();
        return;
      case 'closed/success':
        this.consecutiveFailures = 0;
        return;
      case 'half-open/success':
        this.current = 'closed';
        this.consecutiveFailures = 0;
        this.trial = undefined;
        return;
      case 'half-open/failure':
        this.trip();
        return;
      case 'half-open/neutral':
        this.trial = undefined;
        return;
    }
  }

  private trip(): void {
    this.current = 'open';
    this.openedAt = this.clock.now();
    this.consecutiveFailures = 0;
    this.trial = undefined;
  }

  private cool(): void {
    if (this.current !== BREAKER_COOLDOWN.from || this.clock.now() - this.openedAt < this.openMs) return;
    this.current = BREAKER_COOLDOWN.to;
    this.trial = undefined;
  }
}
