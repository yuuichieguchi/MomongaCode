import { describe, expect, it } from 'vitest';
import { NETWORK_SCOPE_KINDS, NO_NETWORK, OPEN_NETWORK, enforcedNetworkScope, networkScopeWithin } from '@momonga/foundation';
import type { NetworkScope, NetworkScopeKind } from '@momonga/foundation';
import { SANDBOX_NETWORK_SCOPES } from '@momonga/sandbox';
import { proofArith } from '../support/proofs/arith.ts';
import type { ProofArith, ProofBool, ProofInt } from '../support/proofs/arith.ts';
import { expectRefuted, prove } from '../support/proofs/prove.ts';
import { SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS, useZ3 } from '../harness.ts';

const NONE = 0n;
const HOSTS = 1n;
const OPEN = 2n;

type Scope = { rank: ProofInt; member: ProofInt };

const scopeOf = (arith: ProofArith, name: string): Scope => {
  const rank = arith.int(`${name}.rank`);
  const member = arith.int(`${name}.member`);
  arith.given(rank.ge(NONE), rank.le(OPEN), member.ge(0n), member.le(1n));
  return { rank, member };
};

const reaches = (arith: ProofArith, scope: Scope): ProofBool => arith.ctx.Or(scope.rank.eq(OPEN), arith.ctx.And(scope.rank.eq(HOSTS), scope.member.eq(1n)));

const meetOf = (arith: ProofArith, name: string, first: Scope, second: Scope): Scope => {
  const { ctx } = arith;
  const met = scopeOf(arith, name);
  arith.given(
    met.rank.eq(arith.min(first.rank, second.rank)),
    met.member.eq(ctx.If(first.rank.eq(OPEN), second.member, ctx.If(second.rank.eq(OPEN), first.member, first.member.mul(second.member)))),
  );
  return met;
};

type Backend = { hosts: ProofInt; open: ProofInt };

const backendOf = (arith: ProofArith): Backend => {
  const hosts = arith.int('backend.hosts');
  const open = arith.int('backend.open');
  arith.given(hosts.ge(0n), hosts.le(1n), open.ge(0n), open.le(1n));
  return { hosts, open };
};

const kernelOf = (arith: ProofArith, met: Scope, backend: Backend): Scope => {
  const { ctx } = arith;
  const kernel = scopeOf(arith, 'kernel');
  const listed = ctx.Or(ctx.And(met.rank.eq(OPEN), backend.open.eq(1n)), ctx.And(met.rank.eq(HOSTS), backend.hosts.eq(1n)));
  arith.given(kernel.rank.eq(ctx.If(listed, met.rank, ctx.Int.val(NONE))), kernel.member.eq(met.member));
  return kernel;
};

const hostsOf = (...names: string[]): NetworkScope => ({ kind: 'hosts', hosts: names });

describe('the network scope the kernel enforces for a call', () => {
  const z3 = useZ3();

  it('reads the three points of the lattice and the backends the proofs speak about', () => {
    expect(NETWORK_SCOPE_KINDS.map((kind, index) => [kind, BigInt(index)])).toEqual([
      ['none', NONE],
      ['hosts', HOSTS],
      ['open', OPEN],
    ]);
    for (const kinds of Object.values(SANDBOX_NETWORK_SCOPES)) for (const kind of kinds) expect(NETWORK_SCOPE_KINDS).toContain(kind);
  });

  it(
    'I4.1 proves that whatever host the kernel scope reaches, the request, the grant and the backend all reach it, for every combination',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.1');
      const { ctx } = arith;
      const requested = scopeOf(arith, 'requested');
      const granted = scopeOf(arith, 'granted');
      const backend = backendOf(arith);
      const kernel = kernelOf(arith, meetOf(arith, 'met', requested, granted), backend);
      const goal = ctx.And(
        ctx.Implies(reaches(arith, kernel), ctx.And(reaches(arith, requested), reaches(arith, granted))),
        ctx.Implies(kernel.rank.eq(OPEN), ctx.And(requested.rank.eq(OPEN), granted.rank.eq(OPEN), backend.open.eq(1n))),
        ctx.Implies(kernel.rank.eq(HOSTS), backend.hosts.eq(1n)),
      );
      expect(await prove(arith, goal)).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'I4.2 proves a read-only call, whose grant is none, reaches no host whatever it requested',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.2');
      const requested = scopeOf(arith, 'requested');
      const granted = scopeOf(arith, 'granted');
      arith.given(granted.rank.eq(NONE));
      const kernel = kernelOf(arith, meetOf(arith, 'met', requested, granted), backendOf(arith));
      expect(await prove(arith, arith.ctx.And(kernel.rank.eq(NONE), arith.ctx.Not(reaches(arith, kernel))))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'refutes the same claim for a kernel scope taken from the request alone, as it would be without the meet',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.2w');
      const requested = scopeOf(arith, 'requested');
      const granted = scopeOf(arith, 'granted');
      arith.given(granted.rank.eq(NONE));
      const model = await expectRefuted(arith, arith.ctx.Not(reaches(arith, requested)));
      expect(Number(model['requested.rank'])).toBeGreaterThan(0);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it('finds the code equal to the model on every combination of a small universe', () => {
    const universe: readonly NetworkScope[] = [NO_NETWORK, OPEN_NETWORK, hostsOf('a.test'), hostsOf('b.test'), hostsOf('a.test', 'b.test')];
    const backends: ReadonlyArray<readonly NetworkScopeKind[]> = Object.values(SANDBOX_NETWORK_SCOPES);
    const probes = [hostsOf('a.test'), hostsOf('b.test')];
    for (const requested of universe) {
      for (const granted of universe) {
        for (const backend of backends) {
          const kernel = enforcedNetworkScope({ requested, granted, backend });
          const met = universe.filter((candidate) => networkScopeWithin(candidate, requested) && networkScopeWithin(candidate, granted));
          for (const probe of probes) {
            const modelReaches = backend.includes(kernel.kind) && kernel.kind !== 'none' && met.some((candidate) => networkScopeWithin(probe, candidate));
            expect(networkScopeWithin(probe, kernel)).toBe(modelReaches && networkScopeWithin(probe, requested) && networkScopeWithin(probe, granted));
          }
        }
      }
    }
  });
});
