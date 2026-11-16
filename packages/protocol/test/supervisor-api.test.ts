import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '@momonga/protocol';
import type {
  SupervisorChildHealth,
  SupervisorChildState,
  SupervisorExitReason,
  SupervisorHealth,
  SupervisorPhase,
  SupervisorShutdownResponse,
} from '@momonga/protocol';

describe('supervisor control API wire types', () => {
  it('carries no API version of the supervisor socket, which no reader compares', () => {
    expect(Object.keys(protocol)).not.toContain('SUPERVISOR_API_VERSION');
  });

  it('defines the child states including pending', () => {
    expectTypeOf<SupervisorChildState>().toEqualTypeOf<
      'pending' | 'starting' | 'ready' | 'stopping' | 'backoff' | 'held-config' | 'held-version' | 'waiting-lock' | 'external' | 'stopped'
    >();
  });

  it('defines the supervisor phase', () => {
    expectTypeOf<SupervisorPhase>().toEqualTypeOf<'reaping-orphans' | 'running' | 'draining'>();
  });

  it('defines the exit reasons including settings-read-failed and protocol-violation', () => {
    expectTypeOf<SupervisorExitReason>().toEqualTypeOf<
      | 'requested'
      | 'unexpected-clean'
      | 'failure'
      | 'signal'
      | 'lock-held'
      | 'config'
      | 'startup-timeout'
      | 'spawn-failed'
      | 'settings-read-failed'
      | 'protocol-violation'
      | 'retired'
      | 'version-mismatch'
    >();
  });

  it('defines the child health entry with a pending external probe', () => {
    expectTypeOf<SupervisorChildHealth>().toEqualTypeOf<{
      role: 'gateway' | 'runtime';
      state: SupervisorChildState;
      pid?: number;
      startedAt?: string;
      readyAt?: string;
      progressAt?: string;
      restarts: number;
      consecutiveFailures: number;
      nextAttemptAt?: string;
      lastExit?: { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };
      heldReason?: string;
      external?: { pid?: number; probe: 'pending' | 'healthy' | 'unhealthy' | 'unresponsive' | 'unreachable' };
    }>();
  });

  it('defines the health body with phase and no top-level state', () => {
    expectTypeOf<SupervisorHealth>().toEqualTypeOf<{
      status: 'ok';
      version: string;
      pid: number;
      startedAt: string;
      phase: SupervisorPhase;
      env: 'frozen at supervisor start';
      children: SupervisorChildHealth[];
      logs: { droppedLines: number };
      stopBoundMs?: number;
      generation?: number;
      role?: 'starting' | 'serving' | 'retiring';
      steps?: number;
      jobs?: number;
      calls?: number;
      interrupts?: ({ kind: 'run'; id: string } | { kind: 'job'; id: string; command: string })[];
    }>();
    expectTypeOf<SupervisorHealth>().not.toHaveProperty('state');
  });

  it('defines the shutdown response', () => {
    expectTypeOf<SupervisorShutdownResponse>().toEqualTypeOf<{ phase: 'draining' }>();
  });
});
