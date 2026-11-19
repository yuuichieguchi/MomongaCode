import { describe, expect, it } from 'vitest';
import { loadModelsSection, loadWithProject, refusalOf, sentenceOf } from './load-models.ts';

const CAPABILITIES = { contextWindow: 200000, maxOutputTokens: 8192 };

const REMOTE = { adapter: 'open-responses', provider: 'remote', baseUrl: 'https://example.com/v1', models: [{ id: 'remote-model', capabilities: CAPABILITIES }] };
const OTHER = { adapter: 'open-responses', provider: 'other', baseUrl: 'https://other.example.com/v1', models: [{ id: 'other-model', capabilities: CAPABILITIES }] };
const HOME = { adapter: 'ollama', provider: 'home', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'home-model', capabilities: CAPABILITIES }] };
const SUB = { adapter: 'open-responses', provider: 'sub', plan: { profile: 'chatgpt' }, models: [{ id: 'plan-model', capabilities: CAPABILITIES }] };

const REMOTE_MODEL = 'remote/remote-model';
const OTHER_MODEL = 'other/other-model';
const HOME_MODEL = 'home/home-model:latest';
const SUB_MODEL = 'sub/plan-model';

const ALL = [REMOTE, HOME, SUB, OTHER];

const billingWarnings = (warnings: readonly string[]): string[] => warnings.filter((warning) => warning.includes('billingChanges'));

const stepWarning = (file: string, current: string, from: string, next: string, to: string): string =>
  `${file}: models.fallback: ${current} (${from}) is followed by ${next} (${to}), and models.billingChanges allows no change from ${from} to ${to}, so a request never falls from one to the other; add { "from": "${from}", "to": "${to}" } to models.billingChanges to allow it`;

describe('models.billingChanges', () => {
  it('resolves to the declared list', async () => {
    const { models } = await loadModelsSection({ connections: ALL, billingChanges: [{ from: 'local', to: 'metered' }, { from: 'metered', to: 'plan' }] });
    expect(models.billingChanges).toEqual([{ from: 'local', to: 'metered' }, { from: 'metered', to: 'plan' }]);
  });

  it('resolves to an empty list when absent, so no change of who pays is allowed', async () => {
    const { models } = await loadModelsSection({ connections: ALL });
    expect(models.billingChanges).toEqual([]);
  });

  it('refuses a pair whose from equals its to', async () => {
    expect(await sentenceOf({ models: { connections: ALL, billingChanges: [{ from: 'local', to: 'metered' }, { from: 'plan', to: 'plan' }] } })).toBe(
      'models.billingChanges[1]: from and to are both "plan"; a change of billing kind needs two different kinds',
    );
  });

  it('refuses a billing kind it does not know', async () => {
    const { file, message } = await refusalOf({ models: { connections: ALL, billingChanges: [{ from: 'free', to: 'metered' }] } });
    expect(message.startsWith(`${file}: invalid settings at /models/billingChanges/0/from`)).toBe(true);
  });

  it('refuses an entry that is not a pair', async () => {
    const missing = await refusalOf({ models: { connections: ALL, billingChanges: [{ from: 'local' }] } });
    expect(missing.message.startsWith(`${missing.file}: invalid settings at /models/billingChanges/0`)).toBe(true);
    const extra = await refusalOf({ models: { connections: ALL, billingChanges: [{ from: 'local', to: 'metered', also: 1 }] } });
    expect(extra.message.startsWith(`${extra.file}: invalid settings at /models/billingChanges/0`)).toBe(true);
  });

  it('in a project settings file it is discarded with a warning that names the file', async () => {
    const { models, warnings, projectFile } = await loadWithProject({ models: { connections: [REMOTE] } }, { models: { billingChanges: [{ from: 'local', to: 'metered' }] } });
    expect(models.billingChanges).toEqual([]);
    expect(warnings).toContain(`${projectFile}: models.billingChanges is only honored in user settings; discarded`);
  });

  it('the scope of an entry is written under model and resolves to the full reference; a scope that names no model is refused', async () => {
    const { models } = await loadModelsSection({ connections: ALL, billingChanges: [{ from: 'local', to: 'metered', model: 'home-model' }, { from: 'metered', to: 'plan', model: REMOTE_MODEL }] });
    expect(models.billingChanges).toEqual([
      { from: 'local', to: 'metered', model: HOME_MODEL },
      { from: 'metered', to: 'plan', model: REMOTE_MODEL },
    ]);
    expect(await sentenceOf({ models: { connections: ALL, billingChanges: [{ from: 'local', to: 'metered', model: 'nowhere' }] } })).toBe(
      'models.billingChanges[0].model: "nowhere" is not a configured model; configured models: remote-model, home/home-model, plan-model, other-model',
    );
  });
});

describe('the load warning for a fallback step that would change who pays', () => {
  it('is issued once per distinct adjacent pair over the chains of all models, naming both models by their display names', async () => {
    const { file, warnings, models } = await loadModelsSection({ connections: [HOME, REMOTE, OTHER], fallback: [REMOTE_MODEL, HOME_MODEL] });
    expect(models.chains.get(OTHER_MODEL)).toEqual([OTHER_MODEL, REMOTE_MODEL, HOME_MODEL]);
    expect(billingWarnings(warnings)).toEqual([stepWarning(file, 'home/home-model', 'local', 'remote-model', 'metered'), stepWarning(file, 'remote-model', 'metered', 'home/home-model', 'local')]);
  });

  it('is silent once the user allows the pair', async () => {
    const { warnings } = await loadModelsSection({ connections: [HOME, REMOTE], fallback: [REMOTE_MODEL], billingChanges: [{ from: 'local', to: 'metered' }] });
    expect(billingWarnings(warnings)).toEqual([]);
  });

  it('still warns when the allowed pair is scoped to another first model', async () => {
    const { file, warnings } = await loadModelsSection({ connections: [HOME, REMOTE, OTHER], fallback: [REMOTE_MODEL], billingChanges: [{ from: 'local', to: 'metered', model: OTHER_MODEL }] });
    expect(billingWarnings(warnings)).toEqual([stepWarning(file, 'home/home-model', 'local', 'remote-model', 'metered')]);
    const scoped = await loadModelsSection({ connections: [HOME, REMOTE, OTHER], fallback: [REMOTE_MODEL], billingChanges: [{ from: 'local', to: 'metered', model: HOME_MODEL }] });
    expect(billingWarnings(scoped.warnings)).toEqual([]);
  });

  it('treats the direction of the pair as part of it', async () => {
    const { file, warnings } = await loadModelsSection({ connections: [REMOTE, HOME], fallback: [HOME_MODEL], billingChanges: [{ from: 'local', to: 'metered' }] });
    expect(billingWarnings(warnings)).toEqual([stepWarning(file, 'remote-model', 'metered', 'home/home-model', 'local')]);
  });

  it('covers a plan member by the same rule, in either direction', async () => {
    const { file, warnings } = await loadModelsSection({ connections: [SUB, REMOTE], fallback: [REMOTE_MODEL, SUB_MODEL] });
    expect(billingWarnings(warnings)).toEqual([stepWarning(file, 'plan-model', 'plan', 'remote-model', 'metered'), stepWarning(file, 'remote-model', 'metered', 'plan-model', 'plan')]);
  });
});
