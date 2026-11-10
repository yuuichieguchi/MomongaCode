import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readManifest } from './formal/manifest.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const specDir = path.join(repoRoot, 'specs', 'tla');
const spec = fs.readFileSync(path.join(specDir, 'Handover.tla'), 'utf8');

type Actor = { actor: string; file?: string; symbol?: string; design?: string; section?: string; model?: string; status?: string };

const allActors = JSON.parse(fs.readFileSync(path.join(repoRoot, 'specs', 'Handover.actors.json'), 'utf8')) as Actor[];
const actors = allActors.filter((actor) => actor.file !== undefined);
const designActors = allActors.filter((actor) => actor.file === undefined);

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
  it('every actor the model derives still exists at the cited file', () => {
    const missing = actors.filter((actor) => {
      const file = path.join(repoRoot, actor.file ?? '');
      return !fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(actor.symbol ?? '');
    });
    expect(missing.map((actor) => `${actor.actor}: ${actor.file} no longer contains ${JSON.stringify(actor.symbol)}`)).toEqual([]);
  });

  it('every actor derived from the screens design names its design, section, model part and status', () => {
    expect(designActors.length).toBeGreaterThan(0);
    for (const actor of designActors) {
      expect([actor.design, actor.section, actor.model, actor.status].every((field) => typeof field === 'string' && field !== ''), actor.actor).toBe(true);
    }
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
