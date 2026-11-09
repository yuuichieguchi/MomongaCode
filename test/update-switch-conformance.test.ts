import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import * as foundation from '@momonga/foundation';
import { ensureMomongaDirs, generationLayout, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { KernelLockMechanism, MomongaPaths } from '@momonga/foundation';
import { createFakeKernelLock, withTempDir } from '@momonga/testkit';
import { readManifest } from './formal/manifest.ts';

const specDir = path.resolve(import.meta.dirname, '..', 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'UpdateSwitch.tla'), 'utf8');
const mainConfig = fs.readFileSync(path.join(specDir, 'UpdateSwitch.cfg'), 'utf8');
const manifest = readManifest(path.join(specDir, 'manifest.json'));

const definitionOf = (name: string): string => {
  const start = spec.search(new RegExp(`^${name}(\\([^)]*\\))? ==`, 'm'));
  if (start === -1) throw new Error(`${name} is not defined in UpdateSwitch.tla`);
  const end = spec.indexOf('\n\n', start);
  return spec.slice(start, end === -1 ? undefined : end);
};

const constantOf = (name: string): number => {
  const match = new RegExp(`^\\s*${name} = (\\d+)$`, 'm').exec(mainConfig);
  if (match === null) throw new Error(`${name} is not set in UpdateSwitch.cfg`);
  return Number(match[1]);
};

const variants = (): string[] => {
  const match = /ASSUME Variant \\in \{([^}]*)\}/.exec(spec);
  if (match === null) throw new Error('the Variant set is not declared in UpdateSwitch.tla');
  return (match[1] ?? '').split(',').map((item) => item.trim().replace(/^"|"$/g, ''));
};

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const versionOf = (modelVersion: number): string => `0.0.${modelVersion}`;

type Current = { generation: number; version: string };
type StartDecision = { kind: string; generation?: number };
type I3 = {
  decideGenerationStart(view: { clientVersion: string; current?: Current; serving: boolean; starting: readonly Current[] }): StartDecision;
  starterOutcome(view: { own: Current; current?: Current; currentHeld: boolean; currentDraining: boolean; ownSupervisorGone: boolean }): string;
  generationIsLive(paths: MomongaPaths, generation: number, options: { lock: KernelLockMechanism }): Promise<boolean>;
  claimGeneration(paths: MomongaPaths, generation: number, options: { version: string; lock: KernelLockMechanism }): Promise<{ kind: string }>;
};

const i3 = foundation as unknown as I3;

const MAX_GEN = constantOf('MaxGen');
const MAX_V = constantOf('MaxV');

const freshHome = async (context: TestContext): Promise<{ home: string; paths: MomongaPaths }> => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaPaths(home);
  await ensureMomongaDirs(paths);
  return { home, paths };
};

describe('UpdateSwitch.tla and the start flow agree', () => {
  it('every variant of the model has a configuration in the manifest', () => {
    const configs = new Set(manifest.entries.map((entry) => entry.config));
    for (const variant of variants().filter((name) => name !== 'decided')) expect(configs, variant).toContain(`UpdateSwitch.${variant}`);
  });

  it('promotes exactly when the number is above run/current, for every pair the model checks (Promote)', async (context) => {
    expect(definitionOf('Promote')).toContain('ELSE g > cur');
    for (const cur of range(0, MAX_GEN)) {
      for (const g of range(1, MAX_GEN)) {
        const { home, paths } = await freshHome(context);
        if (cur > 0) await publishCurrentGeneration(paths, { generation: cur, version: '0.0.1', sockets: generationLayout(home, cur).sockets });
        await publishCurrentGeneration(paths, { generation: g, version: '0.0.1', sockets: generationLayout(home, g).sockets });
        const published = (JSON.parse(fs.readFileSync(paths.current, 'utf8')) as Current).generation;
        expect(published, `cur ${cur}, g ${g}`).toBe(g > cur ? g : cur);
      }
    }
  });

  it('a generation is live while its supervisor or its starter holds a lock (Starting, Holder)', async (context) => {
    expect(definitionOf('Starting')).toContain('(sup[g] \\/ Holder(g))');
    for (const supervisorHeld of [false, true]) {
      for (const starterHeld of [false, true]) {
        const { home, paths } = await freshHome(context);
        const lock = createFakeKernelLock({ inheritable: false });
        const layout = generationLayout(home, 1) as foundation.GenerationLayout & { startingLock: string };
        fs.mkdirSync(layout.dir, { recursive: true });
        if (supervisorHeld) lock.holdExternally(layout.locks.supervisor, 5000);
        if (starterHeld) lock.holdExternally(layout.startingLock, 5001);
        expect(await i3.generationIsLive(paths, 1, { lock }), `supervisor ${supervisorHeld}, starter ${starterHeld}`).toBe(supervisorHeld || starterHeld);
      }
    }
  });

  it('a supervisor claims only a directory whose start record names its version (SupClaim)', async (context) => {
    expect(definitionOf('SupClaim')).toContain('ELSE (dir[g] /\\ ver[g] = iv)');
    for (const dirExists of [false, true]) {
      for (const recorded of range(1, MAX_V)) {
        for (const installed of range(1, MAX_V)) {
          const { home, paths } = await freshHome(context);
          const lock = createFakeKernelLock({ inheritable: false });
          const layout = generationLayout(home, 1);
          if (dirExists) {
            fs.mkdirSync(layout.dir, { recursive: true });
            fs.writeFileSync(path.join(layout.dir, 'start.json'), JSON.stringify({ version: versionOf(recorded), foldVersion: 1 }));
          }
          const outcome = await i3.claimGeneration(paths, 1, { version: versionOf(installed), lock });
          expect(outcome.kind, `dir ${dirExists}, recorded ${recorded}, installed ${installed}`).toBe(dirExists && recorded === installed ? 'claimed' : 'abandoned');
        }
      }
    }
  });

  it('refuses below the floor, joins, or allocates exactly as FloorNow, JoinNow and AllocNow decide', () => {
    expect(definitionOf('FloorNow')).toContain('/\\ ~Srv');
    expect(definitionOf('FloorNow')).toContain('/\\ cv[c] < curv');
    expect(definitionOf('JoinNow')).toContain('ver[g] >= cv[c]');
    for (const curv of range(0, MAX_V)) {
      for (const cv of range(1, MAX_V)) {
        for (const startingVersion of [undefined, ...range(1, MAX_V)]) {
          const current = curv === 0 ? undefined : { generation: 1, version: versionOf(curv) };
          const starting = startingVersion === undefined ? [] : [{ generation: 2, version: versionOf(startingVersion) }];
          const decision = i3.decideGenerationStart({ clientVersion: versionOf(cv), ...(current === undefined ? {} : { current }), serving: false, starting });
          const expected = cv < curv ? 'below-floor' : startingVersion !== undefined && startingVersion >= cv ? 'join' : 'allocate';
          expect(decision.kind, `curv ${curv}, cv ${cv}, starting ${String(startingVersion)}`).toBe(expected);
        }
      }
    }
  });

  it("reports the starter's success exactly when ConnectStarter allows it", () => {
    const guard = definitionOf('ConnectStarter');
    for (const clause of ['/\\ cur # 0', '/\\ cur >= pend[c]', '/\\ cv[c] <= curv', '(Srv \\/ Variant = "staleStarter")']) expect(guard).toContain(clause);
    for (const pend of range(1, MAX_GEN)) {
      for (const cur of range(0, MAX_GEN)) {
        for (const cv of range(1, MAX_V)) {
          for (const curv of range(1, MAX_V)) {
            for (const held of [false, true]) {
              for (const draining of [false, true]) {
                const outcome = i3.starterOutcome({
                  own: { generation: pend, version: versionOf(cv) },
                  ...(cur === 0 ? {} : { current: { generation: cur, version: versionOf(curv) } }),
                  currentHeld: held,
                  currentDraining: draining,
                  ownSupervisorGone: false,
                });
                const allowed = cur !== 0 && cur >= pend && cv <= curv && held && !draining;
                expect(outcome === 'success', `pend ${pend}, cur ${cur}, cv ${cv}, curv ${curv}, held ${held}, draining ${draining}`).toBe(allowed);
              }
            }
          }
        }
      }
    }
  });
});
