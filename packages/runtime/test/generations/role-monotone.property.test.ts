import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRolePort, ensureMomongaDirs, generationSockets, momongaPaths } from '@momonga/foundation';
import type { EndpointScope, GenerationRole, MomongaPaths } from '@momonga/foundation';
import { forEachSeed, seedsFrom, testEndpointScope, withTempDir } from '@momonga/testkit';
import type { Generator } from '@momonga/testkit';

const PROPERTY_SEEDS = seedsFrom(1, 200);
const MOST_TICKS = 30;
const OWN_GENERATION = 5;
const CONTENTS = ['absent', 'own', 'lower', 'higher'] as const;
const ROLE_ORDER: readonly GenerationRole[] = ['starting', 'serving', 'retiring'];

const writeCurrent = (paths: MomongaPaths, scope: EndpointScope, content: (typeof CONTENTS)[number]): void => {
  if (content === 'absent') {
    fs.rmSync(paths.current, { force: true });
    return;
  }
  const generation = content === 'own' ? OWN_GENERATION : content === 'lower' ? OWN_GENERATION - 1 : OWN_GENERATION + 1;
  fs.writeFileSync(paths.current, `${JSON.stringify({ generation, version: '9.9.9', sockets: generationSockets(paths.home, generation, scope) })}\n`);
};

describe('T-I4-31 a role only moves starting, serving, retiring (design-update 15.5, 17.1)', () => {
  it('the observed role sequence never moves back, whatever run/current holds between ticks', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const scope = await testEndpointScope(paths);
    await forEachSeed('role monotone', PROPERTY_SEEDS, async (generator: Generator) => {
      const port = createRolePort({ paths, generation: OWN_GENERATION, logger: { warn: () => undefined } });
      const contents = Array.from({ length: 1 + generator.below(MOST_TICKS) }, () => generator.pick(CONTENTS));
      const seen: GenerationRole[] = [];
      for (const content of contents) {
        writeCurrent(paths, scope, content);
        seen.push(await port.refresh());
      }
      const ranks = seen.map((role) => ROLE_ORDER.indexOf(role));
      expect(ranks, `run/current ${contents.join(', ')} gave ${seen.join(', ')}`).toEqual([...ranks].sort((left, right) => left - right));
    });
  });
});
