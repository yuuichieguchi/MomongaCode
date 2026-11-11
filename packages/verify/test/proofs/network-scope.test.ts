import { describe, expect, it } from 'vitest';
import { NETWORK_SCOPE_KINDS, NO_NETWORK, OPEN_NETWORK, enforcedNetworkScope, networkScopeWithin } from '@momonga/foundation';
import type { NetworkScope, NetworkScopeKind } from '@momonga/foundation';
import { SANDBOX_NETWORK_SCOPES, tunnelOpeningAdmits } from '@momonga/sandbox';
import type { TunnelOpening } from '@momonga/sandbox';
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

type Answer = { address: ProofInt; acceptable: ProofBool };

const answerOf = (arith: ProofArith, name: string): Answer => {
  const address = arith.int(`${name}.address`);
  const publicAddress = arith.int(`${name}.public`);
  const grantedAddress = arith.int(`${name}.granted`);
  arith.given(publicAddress.ge(0n), publicAddress.le(1n), grantedAddress.ge(0n), grantedAddress.le(1n));
  return { address, acceptable: arith.ctx.Or(publicAddress.eq(1n), grantedAddress.eq(1n)) };
};

const sameAddressSameFacts = (arith: ProofArith, first: Answer, second: Answer): void => {
  arith.given(arith.ctx.Implies(first.address.eq(second.address), first.acceptable.eq(second.acceptable)));
};

type Tunnel = { carried: ProofBool; dialed: ProofInt; dialedAcceptable: ProofBool; presented: ProofInt; granted: ProofInt };

const tunnelOf = (arith: ProofArith, answers: readonly [Answer, Answer], dial: Answer, nameChecked: boolean): Tunnel => {
  const { ctx } = arith;
  const [first, second] = answers;
  const presented = arith.int('opening.name');
  const granted = arith.int('connect.name');
  const admitted = ctx.Or(first.acceptable, second.acceptable);
  const carried = nameChecked ? ctx.And(admitted, presented.eq(granted)) : admitted;
  return { carried, dialed: dial.address, dialedAcceptable: dial.acceptable, presented, granted };
};

const judgedDial = (arith: ProofArith, [first, second]: readonly [Answer, Answer]): Answer => ({
  address: arith.ctx.If(first.acceptable, first.address, second.address) as ProofInt,
  acceptable: arith.ctx.If(first.acceptable, first.acceptable, second.acceptable) as ProofBool,
});

const carriedGoal = (arith: ProofArith, answers: readonly [Answer, Answer], tunnel: Tunnel): ProofBool => {
  const { ctx } = arith;
  return ctx.Implies(
    tunnel.carried,
    ctx.And(ctx.Or(...answers.map((answer) => tunnel.dialed.eq(answer.address))), tunnel.dialedAcceptable, tunnel.presented.eq(tunnel.granted)),
  );
};

describe('a granted tunnel reaches the address the proxy judged, for the name it was granted (DECISION-2)', () => {
  const z3 = useZ3();

  it(
    'I4.6 proves a carried tunnel is dialed to an acceptable address of the one lookup the proxy made, and names the granted name; the lookup step is the proxy test "resolves a name once for a direct connection, and connects to that answer"',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.6');
      const answers = [answerOf(arith, 'answer1'), answerOf(arith, 'answer2')] as const;
      sameAddressSameFacts(arith, answers[0], answers[1]);
      const tunnel = tunnelOf(arith, answers, judgedDial(arith, answers), true);
      expect(await prove(arith, carriedGoal(arith, answers, tunnel))).toEqual({ status: 'proved' });
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'refutes the claim for a dial that looks the name up again, as a proxy that hands the name to the connection would',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.6w1');
      const answers = [answerOf(arith, 'answer1'), answerOf(arith, 'answer2')] as const;
      const tunnel = tunnelOf(arith, answers, answerOf(arith, 'second'), true);
      await expectRefuted(arith, carriedGoal(arith, answers, tunnel));
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it(
    'refutes the claim for a tunnel that carries any bytes once the CONNECT name is granted',
    async () => {
      const arith = proofArith(z3.engine().api, 'I4.6w2');
      const answers = [answerOf(arith, 'answer1'), answerOf(arith, 'answer2')] as const;
      const tunnel = tunnelOf(arith, answers, judgedDial(arith, answers), false);
      const model = await expectRefuted(arith, carriedGoal(arith, answers, tunnel));
      expect(model['opening.name']).not.toBe(model['connect.name']);
    },
    SOLVER_SINGLE_QUERY_TEST_TIMEOUT_MS,
  );

  it('finds the code that judges the first bytes of a tunnel equal to the model on a small universe', () => {
    const names = ['a.test', 'A.test', 'b.test', '127.0.0.1'];
    const openings: TunnelOpening[] = [
      { kind: 'other' },
      { kind: 'tls', name: undefined },
      { kind: 'http', host: undefined },
      ...names.flatMap((name): TunnelOpening[] => [{ kind: 'tls', name }, { kind: 'http', host: name }, { kind: 'http', host: `${name}:8080` }]),
    ];
    for (const granted of ['a.test', '127.0.0.1']) {
      for (const opening of openings) {
        const presented = opening.kind === 'tls' ? opening.name : opening.kind === 'http' ? opening.host?.replace(/:8080$/, '').toLowerCase() : undefined;
        const address = granted === '127.0.0.1';
        const modelCarries =
          opening.kind === 'http' ? presented === granted : opening.kind === 'tls' ? (address ? presented === undefined : presented?.toLowerCase() === granted) : false;
        expect(tunnelOpeningAdmits(granted, opening)).toBe(modelCarries);
      }
    }
  });
});
