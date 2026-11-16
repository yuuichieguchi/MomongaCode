import { describe, expect, it } from 'vitest';
import { PropertyFailure, forEachSeed, seedsFrom } from '@momonga/testkit';
import type { Generator } from '@momonga/testkit';
import { upstreamCallKey } from '../src/core/upstream-call-key.ts';
import type { CallIdentity } from '../src/core/upstream-call-key.ts';

const PROPERTY_SEEDS = seedsFrom(1, 200);
const MOST_SENDS = 40;
const KEYS = ['run-1:step-1', 'run-1:step-2', 'run-2:step-1', 'k'];
const DIGESTS = ['d-a', 'd-b', 'd-c'];
const TARGETS = ['ollama/qwen', 'openai/gpt', 'anthropic/claude'];

type Send = { logical: string; call: CallIdentity; target: string };

type Derive = (call: CallIdentity, target: string) => string;

const logicalOf = (call: CallIdentity, target: string): string => (call.kind === 'keyed' ? `keyed ${call.key} ${call.digest} ${target}` : `unkeyed ${call.nonce} ${target}`);

const sendsOf = (generator: Generator): Send[] => {
  const sends: Send[] = [];
  let nonces = 0;
  const count = 1 + generator.below(MOST_SENDS);
  for (let index = 0; index < count; index += 1) {
    const earlier = sends.length > 0 && generator.below(3) === 0 ? generator.pick(sends) : undefined;
    if (earlier !== undefined) {
      sends.push(earlier);
      continue;
    }
    const target = generator.pick(TARGETS);
    const call: CallIdentity = generator.below(4) === 0 ? { kind: 'unkeyed', nonce: `nonce-${(nonces += 1)}` } : { kind: 'keyed', key: generator.pick(KEYS), digest: generator.pick(DIGESTS) };
    sends.push({ logical: logicalOf(call, target), call, target });
  }
  return sends;
};

const keyViolations = (sends: readonly Send[], derive: Derive): string[] => {
  const violations: string[] = [];
  const byLogical = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const send of sends) {
    const key = derive(send.call, send.target);
    const seen = byLogical.get(send.logical);
    if (seen !== undefined && seen !== key) violations.push(`two sends of ${send.logical} got two keys`);
    byLogical.set(send.logical, key);
    const owner = byKey.get(key);
    if (owner !== undefined && owner !== send.logical) violations.push(`${owner} and ${send.logical} got the same key`);
    byKey.set(key, send.logical);
  }
  return violations;
};

const holdsFor =
  (derive: Derive) =>
  (generator: Generator): void => {
    expect(keyViolations(sendsOf(generator), derive)).toEqual([]);
  };

describe('K2: the upstream key is the same for two sends of one logical call and differs for two logical calls, over generated call sequences', () => {
  it('holds for upstreamCallKey: a resend keeps its key, and another caller key, request digest, nonce or target gives another key (K2, K3)', async () => {
    await forEachSeed('K2 upstream call key', PROPERTY_SEEDS, holdsFor(upstreamCallKey));
  });

  it('fails, naming the seed, for a planted derivation that leaves the target out (K3) or the request digest out', async () => {
    const withoutTarget: Derive = (call) => upstreamCallKey(call, 'one');
    const withoutDigest: Derive = (call, target) => upstreamCallKey(call.kind === 'keyed' ? { ...call, digest: '' } : call, target);
    for (const planted of [withoutTarget, withoutDigest]) {
      const failure = await forEachSeed('K2 planted', PROPERTY_SEEDS, holdsFor(planted)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PropertyFailure);
      expect((failure as PropertyFailure).message).toMatch(/fails for seed \d+/);
    }
  });
});
