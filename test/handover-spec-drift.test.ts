import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { readManifest } from './formal/manifest.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const specDir = path.join(repoRoot, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'Handover.tla'), 'utf8');

type CodePlace = { readonly file: string; readonly export: string };

type Actor = {
  readonly actor: string;
  readonly model: readonly string[];
  readonly code?: readonly CodePlace[];
  readonly notBuilt?: { readonly design: string; readonly section: string };
  readonly environment?: string;
  readonly evidenceOnly?: string;
  readonly arguedAway?: string;
};

const ACTORS_FILE = path.join(specDir, 'Handover.actors.json');

const actors = JSON.parse(fs.readFileSync(ACTORS_FILE, 'utf8')) as readonly Actor[];

const KINDS = ['code', 'notBuilt', 'environment', 'evidenceOnly', 'arguedAway'] as const;

const kindsOf = (actor: Actor): string[] => KINDS.filter((kind) => actor[kind] !== undefined);

const assumedVariants = (): string[] => {
  const line = spec.split('\n').find((text) => text.startsWith('ASSUME Variant \\in')) ?? '';
  return [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();
};

const nextActions = (): string[] => {
  const start = spec.indexOf('Next ==');
  const end = spec.indexOf('\n\n', start);
  return [...spec.slice(start, end).matchAll(/\\\/ (\w+)/g)].map((match) => match[1] as string).sort();
};

const definedActions = (): string[] =>
  nextActions().filter((name) => new RegExp(`^${name} ==`, 'm').test(spec));

const handoverConfigs = fs.readdirSync(specDir).filter((file) => file.startsWith('Handover') && file.endsWith('.cfg'));

describe('the Handover model and the code it describes do not drift', () => {
  it('keeps the actors with the other model inputs under specs/tla, and nowhere else', () => {
    expect(fs.existsSync(ACTORS_FILE)).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'specs', 'Handover.actors.json'))).toBe(false);
  });

  it('gives every actor exactly one origin: code, not built with its design, the environment, evidence only, or argued away', () => {
    for (const actor of actors) expect(kindsOf(actor), actor.actor).toHaveLength(1);
    for (const actor of actors.filter((entry) => entry.notBuilt !== undefined)) {
      expect([actor.notBuilt?.design, actor.notBuilt?.section].every((field) => typeof field === 'string' && field !== ''), actor.actor).toBe(true);
    }
  });

  it('ties every built actor to a value its module exports, loaded from the module itself', async () => {
    const places = actors.flatMap((actor) => (actor.code ?? []).map((place) => ({ actor: actor.actor, place })));
    expect(places.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const { actor, place } of places) {
      const loaded = (await import(path.join(repoRoot, place.file))) as Record<string, unknown>;
      if (loaded[place.export] === undefined) missing.push(`${actor}: ${place.file} exports no ${place.export}`);
    }
    expect(missing).toEqual([]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);

  it('names in every actor only parts the model defines, and every action of Next is claimed by an actor', () => {
    const defined = (name: string): boolean => new RegExp(`^${name} ==`, 'm').test(spec);
    for (const actor of actors) for (const name of actor.model) expect(defined(name), `${actor.actor} names ${name}`).toBe(true);
    const claimed = new Set(actors.flatMap((actor) => actor.model));
    expect(nextActions().filter((action) => !claimed.has(action))).toEqual([]);
  });

  it('claims an action as built only through code, and lists no built action as not built', () => {
    const built = new Set(actors.filter((actor) => actor.code !== undefined).flatMap((actor) => actor.model));
    const unbuilt = actors.filter((actor) => actor.notBuilt !== undefined).flatMap((actor) => actor.model);
    expect(unbuilt.filter((name) => built.has(name))).toEqual([]);
  });

  it('every Next action of the model is defined', () => {
    expect(definedActions()).toEqual(nextActions());
    expect(nextActions().length).toBeGreaterThan(0);
  });

  it('every configuration names a variant the module assumes', () => {
    const assumed = assumedVariants();
    expect(assumed).toEqual(['decided', 'echoKept', 'envLost', 'envLostNoLeave', 'moveWithDialog', 'moveWithSwitch', 'noPrintedSkip', 'reenterWrites', 'refuseLeavesModes', 'restoreBeforeExec', 'retryOnExecFail']);
    for (const config of handoverConfigs) {
      const match = fs.readFileSync(path.join(specDir, config), 'utf8').match(/Variant = "([^"]+)"/);
      expect(assumed, config).toContain(match?.[1]);
    }
  });

  it('every configuration names a screen the module assumes', () => {
    const line = spec.split('\n').find((text) => text.startsWith('ASSUME Screen \\in')) ?? '';
    const assumed = [...line.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string).sort();
    expect(assumed).toEqual(['both', 'fullscreen', 'scrollback']);
    for (const config of handoverConfigs) {
      const match = fs.readFileSync(path.join(specDir, config), 'utf8').match(/Screen = "([^"]+)"/);
      expect(assumed, config).toContain(match?.[1]);
    }
  });

  it('the manifest rows for the Handover configurations match the files on disk', () => {
    const manifest = readManifest(path.join(specDir, 'manifest.json'));
    const listed = manifest.entries.map((entry) => entry.config).filter((name) => name.startsWith('Handover')).sort();
    expect(listed).toEqual(handoverConfigs.map((file) => file.slice(0, -'.cfg'.length)).sort());
  });
});
