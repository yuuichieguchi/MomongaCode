import type { Clock } from './clock.ts';

export type CircuitBreakerOptions = {
  failureThreshold: number;
  openMs: number;
  clock: Clock;
};

export type CircuitState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly clock: Clock;
  private current: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialStartedAt = 0;
  private lastTrialFailed = false;

  constructor(options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new RangeError(`CircuitBreaker: failureThreshold must be a positive integer, got ${options.failureThreshold}`);
    }
    if (!Number.isInteger(options.openMs) || options.openMs < 1) {
      throw new RangeError(`CircuitBreaker: openMs must be a positive integer, got ${options.openMs}`);
    }
    this.failureThreshold = options.failureThreshold;
    this.openMs = options.openMs;
    this.clock = options.clock;
  }

  get state(): CircuitState {
    return this.current;
  }

  get trialFailed(): boolean {
    return this.lastTrialFailed;
  }

  remainingOpenMs(): number {
    if (this.current === 'closed') return 0;
    const since = this.current === 'open' ? this.openedAt : this.trialStartedAt;
    return Math.max(0, this.openMs - (this.clock.now() - since));
  }

  canPass(): boolean {
    if (this.current === 'closed') return true;
    const now = this.clock.now();
    if (this.current === 'half-open') {
      if (now - this.trialStartedAt < this.openMs) return false;
      this.trialStartedAt = now;
      return true;
    }
    if (now - this.openedAt < this.openMs) return false;
    this.current = 'half-open';
    this.trialStartedAt = now;
    return true;
  }

  onSuccess(): void {
    if (this.current === 'open') return;
    this.current = 'closed';
    this.consecutiveFailures = 0;
    this.lastTrialFailed = false;
  }

  onNeutral(): void {
    if (this.current === 'half-open') this.trialStartedAt = Number.NEGATIVE_INFINITY;
  }

  onFailure(): void {
    if (this.current === 'half-open') {
      this.lastTrialFailed = true;
      this.trip();
      return;
    }
    if (this.current === 'open') return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.current = 'open';
    this.openedAt = this.clock.now();
  }
}
