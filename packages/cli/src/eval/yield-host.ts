import type { UserModels } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import { caseSettingsFor, failedWithCleanup, runYieldDataset } from '@momonga/eval';
import type { PolicyOverlay, YieldCandidate, YieldDataset, YieldFamily, YieldFamilyRun, YieldPorts } from '@momonga/eval';
import type { MemoryView } from '@momonga/protocol';
import type { RuntimeClient } from '../client/runtime-client.ts';
import { ContextInterrupted, createHomes, liveSettingsFor, needsPlanRelay, readCredentials, readPlanRelay, sweepStaleHomes } from './context-host.ts';
import type { ContextRuntime, HomeEffects, Homes, ReflectionBounds } from './context-host.ts';

export type YieldRuntime = ContextRuntime & Pick<RuntimeClient, 'memories'>;

export type YieldHostEffects = HomeEffects<YieldRuntime> & { copyWorkspace(from: string, to: string): Promise<void> };

export const YIELD_POLICY: PolicyOverlay = {};

export type YieldLiveInput = {
  dataset: YieldDataset;
  model: string;
  models: UserModels;
  reflection: ReflectionBounds;
  codeDigest: string;
  interrupt: AbortSignal;
  onUnreadableHomes?(count: number): void;
  onUnownedHomes?(roots: readonly string[]): void;
  planRelaySocket?(): Promise<string>;
};

const memoryOf = (settings: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const memory = settings['memory'];
  return isRecord(memory) ? memory : {};
};

export const familySettingsFor = (base: Readonly<Record<string, unknown>>, family: YieldFamily): Record<string, unknown> => {
  const settings = caseSettingsFor(base, { policy: YIELD_POLICY });
  return {
    ...settings,
    memory: { ...memoryOf(settings), repositoryFacts: false },
    verification: { commands: [family.learn.verification] },
  };
};

export const candidatesOfRun = (memories: readonly MemoryView[], runId: string): YieldCandidate[] =>
  memories
    .filter((memory) => memory.state === 'candidate' && memory.source.kind === 'reflection' && memory.source.runId === runId)
    .map((memory) => ({ text: memory.text, paths: [...new Set(memory.evidence.flatMap((evidence) => (evidence.kind === 'file' ? [evidence.path] : [])))] }));

const yieldHostsOf = (effects: YieldHostEffects, homes: Homes<YieldRuntime>, base: Readonly<Record<string, unknown>>): Pick<YieldPorts, 'openLearn' | 'openReuse'> => ({
  openLearn: async (family) => {
    const home = await homes.open({
      label: `the learn session of family ${family.id}`,
      settings: familySettingsFor(base, family),
      ...(family.learn.files === undefined ? {} : { files: family.learn.files }),
    });
    const { cwd, runtime } = home;
    return {
      cwd,
      api: home.api,
      candidatesOf: async (runId) => candidatesOfRun(await runtime.memories({ project: cwd, state: 'candidate' }), runId),
      applyStep: (step) => effects.applyStep(cwd, step),
      close: home.close,
    };
  },
  openReuse: async (family, arm, learn) => {
    const home = await homes.open({ label: `the ${arm} arm of family ${family.id}`, settings: familySettingsFor(base, family) });
    const { cwd, runtime } = home;
    try {
      await effects.copyWorkspace(learn.cwd, cwd);
    } catch (error) {
      try {
        await home.close();
      } catch (cleanup) {
        throw failedWithCleanup(error, cleanup, `the ${arm} arm of family ${family.id} could not copy the workspace and its temporary home was not released`);
      }
      throw error;
    }
    return {
      cwd,
      api: home.api,
      seedMemory: async (memory) => ({ id: (await runtime.addMemory({ text: memory.text, scope: 'project', project: cwd, paths: memory.paths })).id }),
      close: home.close,
    };
  },
});

const disposeAfter = async (homes: Homes<YieldRuntime>, error: unknown): Promise<void> => {
  try {
    await homes.dispose();
  } catch (cleanup) {
    throw failedWithCleanup(error, cleanup, 'the yield benchmark failed and its temporary homes were not fully released');
  }
};

export const runYieldLive = async (effects: YieldHostEffects, input: YieldLiveInput): Promise<YieldFamilyRun[]> => {
  const { interrupt } = input;
  interrupt.throwIfAborted();
  const relay = needsPlanRelay(input.models, [input.model]) && input.planRelaySocket !== undefined ? await readPlanRelay(await input.planRelaySocket(), interrupt) : undefined;
  const settings = liveSettingsFor(input.models, [input.model], relay);
  const credentialValues = await readCredentials(effects, settings.credentials, interrupt);
  const swept = await sweepStaleHomes(effects);
  if (swept.unreadable > 0) input.onUnreadableHomes?.(swept.unreadable);
  if (swept.unowned.length > 0) input.onUnownedHomes?.(swept.unowned);
  const homes = createHomes(effects, {
    credentialValues,
    reflection: input.reflection,
    managedTargets: settings.managedTargets,
    endpointProbes: settings.endpointProbes,
    interrupt,
  });
  const base = { models: settings.models, ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }) };
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt.addEventListener('abort', () => reject(new ContextInterrupted()), { once: true });
  });
  const running = runYieldDataset(input.dataset, { model: input.model, policy: YIELD_POLICY, codeDigest: input.codeDigest, ...yieldHostsOf(effects, homes, base) });
  let runs: YieldFamilyRun[];
  try {
    runs = await Promise.race([running, interrupted]);
  } catch (error) {
    await disposeAfter(homes, error);
    void running.catch(() => undefined);
    throw error;
  }
  await homes.dispose();
  return runs;
};
