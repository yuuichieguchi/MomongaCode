import { describe, expect, expectTypeOf, it } from 'vitest';
import { SUPERVISOR_API_VERSION } from '@momonga/protocol';
import type {
  SupervisorChildHealth,
  SupervisorChildState,
  SupervisorExitReason,
  SupervisorHealth,
  SupervisorPhase,
  SupervisorShutdownResponse,
} from '@momonga/protocol';

describe('supervisor control API wire types', () => {
  it('pins the API version', () => {
    expect(SUPERVISOR_API_VERSION).toBe(1);
    expectTypeOf<typeof SUPERVISOR_API_VERSION>().toEqualTypeOf<1>();
  });

  it('defines the child states including pending', () => {
    expectTypeOf<SupervisorChildState>().toEqualTypeOf<
      'pending' | 'starting' | 'ready' | 'stopping' | 'backoff' | 'held-config' | 'waiting-lock' | 'external' | 'stopped'
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
    >();
  });

  it('defines the child health entry with a pending external probe', () => {
    expectTypeOf<SupervisorChildHealth>().toEqualTypeOf<{
      role: 'gateway' | 'runtime';
      state: SupervisorChildState;
      pid?: number;
      startedAt?: string;
      readyAt?: string;
      restarts: number;
      consecutiveFailures: number;
      nextAttemptAt?: string;
      lastExit?: { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };
      heldReason?: string;
      external?: { pid?: number; probe: 'pending' | 'healthy' | 'unhealthy' | 'unreachable' };
    }>();
  });

  it('defines the health body with phase and no top-level state', () => {
    expectTypeOf<SupervisorHealth>().toEqualTypeOf<{
      status: 'ok';
      version: string;
      apiVersion: 1;
      pid: number;
      startedAt: string;
      phase: SupervisorPhase;
      env: 'frozen at supervisor start';
      children: SupervisorChildHealth[];
      logs: { droppedLines: number };
      stopBoundMs?: number;
    }>();
    expectTypeOf<SupervisorHealth>().not.toHaveProperty('state');
  });

  it('defines the shutdown response', () => {
    expectTypeOf<SupervisorShutdownResponse>().toEqualTypeOf<{ phase: 'draining' }>();
  });
});
