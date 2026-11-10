import { AUTO_MODE_DATASET_TEXT, autoFitDirectoryOf, autoFitKeyOf, autoFitViewOf, autoGatePasses, loadUserModels, readAutoFitRecord, readClassifierProbeKeys, systemFileLockPorts, writeAutoFitRecord } from '@momonga/config';
import type { AutoFitKey, UserModels } from '@momonga/config';
import { STARTUP_TIMEOUT_MS, createBinaryHashCache, createHostExec, probeKeyComponentLabel } from '@momonga/foundation';
import { autoGateRecordOf, caseSettingsFor, formatReport, parseDataset, runDataset } from '@momonga/eval';
import type { GoldenDataset } from '@momonga/eval';
import { autoModeNotice } from '@momonga/protocol';
import type { AutoModeSurface } from '@momonga/protocol';
import { createHomes, liveSettingsFor, readCredentials, sweepStaleHomes, unownedHomesNotice, unreadableHomesNotice } from '../eval/context-host.ts';
import type { ContextHostEffects, ReflectionBounds } from '../eval/context-host.ts';
import type { CliPorts } from '../ports.ts';
import { nodeContextEffects } from '../eval/context-effects.ts';

export class AutoModeCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoModeCheckError';
  }
}

export type AutoModeCheckPorts = {
  effects: ContextHostEffects;
  models: UserModels;
  configuredClassifier: string | undefined;
  home: string;
  version: string;
  now(): number;
  randomHex(bytes: number): string;
  reflection: ReflectionBounds;
  write(text: string): void;
};

export type AutoModeCheckOptions = { classifier?: string; agent: string; signal: AbortSignal };

export type AutoModeCheckOutcome = { measurement: 'passed' | 'did_not_pass' | 'unmeasurable' };

export type AutoModeStatusPorts = { models: UserModels; configuredClassifier: string | undefined; home: string; platform: NodeJS.Platform; write(text: string): void };

export type AutoModeStatusOptions = { classifier?: string; surface: AutoModeSurface };

export type AutoModeStatusOutcome = { measurement: 'passed' | 'did_not_pass' | 'not_measured' };

const classifierOf = (configured: string | undefined, named: string | undefined): string => {
  const classifier = named ?? configured;
  if (classifier === undefined) throw new AutoModeCheckError('no classifier alias: name one, or set autoMode.classifier in the user settings');
  return classifier;
};

const requireDefinedClassifier = (models: UserModels, classifier: string): void => {
  const members = models.resolved.aliases[classifier];
  if (members === undefined) throw new AutoModeCheckError(`the alias ${classifier} is not defined in models.aliases`);
  for (const name of [members].flat()) {
    if (models.resolved.targets[name] === undefined) throw new AutoModeCheckError(`the alias ${classifier} names the target ${name}, which is not defined`);
  }
};

const classifierKeyOf = async (models: UserModels, classifier: string, platform: NodeJS.Platform, given: AbortSignal | undefined): Promise<AutoFitKey> => {
  const bound = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
  const signal = given === undefined ? bound : AbortSignal.any([given, bound]);
  const probeKeys = await readClassifierProbeKeys(models.resolved, classifier, { exec: createHostExec(), hashes: createBinaryHashCache(), platform, signal });
  const result = autoFitKeyOf(models.resolved, classifier, await classifierCodeOf(), probeKeys);
  if (result.kind === 'unknown') throw new AutoModeCheckError(`the classifier target ${result.target} has no probe key: its ${probeKeyComponentLabel(result.component)} could not be read (${result.reason})`);
  return result.key;
};

const classifierCodeOf = async () => (await import('@momonga/runtime')).AUTO_CLASSIFIER_CODE;

const progressOf = (dataset: GoldenDataset, write: (text: string) => void): ((caseId: string, runIndex: number) => void) => {
  let done = 0;
  const lastRun = new Map(dataset.cases.map((golden) => [golden.id, golden.runs - 1]));
  return (caseId, runIndex) => {
    if (lastRun.get(caseId) !== runIndex) return;
    done += 1;
    write(`auto-mode check: case ${caseId} done (${done}/${dataset.cases.length})\n`);
  };
};

export const autoModeCheck = async (ports: AutoModeCheckPorts, options: AutoModeCheckOptions): Promise<AutoModeCheckOutcome> => {
  const { signal } = options;
  signal.throwIfAborted();
  const classifier = classifierOf(ports.configuredClassifier, options.classifier);
  requireDefinedClassifier(ports.models, classifier);
  const dataset = parseDataset(AUTO_MODE_DATASET_TEXT, 'auto-mode.json');
  const key = await classifierKeyOf(ports.models, classifier, ports.effects.platform, signal);
  const settings = liveSettingsFor(ports.models, [options.agent, classifier]);
  const credentialValues = await readCredentials(ports.effects, settings.credentials, signal);
  const swept = await sweepStaleHomes(ports.effects);
  if (swept.unreadable > 0) ports.write(unreadableHomesNotice(swept.unreadable));
  if (swept.unowned.length > 0) ports.write(unownedHomesNotice(swept.unowned));
  const homes = createHomes(ports.effects, {
    credentialValues,
    reflection: ports.reflection,
    managedTargets: settings.managedTargets,
    endpointProbes: settings.endpointProbes,
    interrupt: signal,
  });
  const base = { models: settings.models, ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }) };
  const progress = progressOf(dataset, ports.write);
  ports.write(`auto-mode check: classifier ${classifier}, agent ${options.agent}, ${dataset.cases.reduce((total, golden) => total + golden.runs, 0)} runs, each in its own temporary home\n`);
  try {
    const report = await runDataset(dataset, {
      modelAlias: options.agent,
      open: async (golden, runIndex) => {
        signal.throwIfAborted();
        const home = await homes.open({
          label: `case ${golden.id} run ${runIndex}`,
          settings: caseSettingsFor(base, { classifier }),
          ...(golden.files === undefined ? {} : { files: golden.files }),
        });
        return { api: home.api, workspace: { cwd: home.cwd, env: home.env }, close: home.close };
      },
      onTranscript: async (run) => progress(run.caseId, run.runIndex),
    });
    const record = autoGateRecordOf(report, { key, agentAlias: options.agent, recordedAt: new Date(ports.now()).toISOString(), version: ports.version });
    ports.write(`${formatReport(report)}\n`);
    if (record === undefined) {
      ports.write('the measurement could not be made: no decision of a labelled kind was observed, so no record was written\n');
      return { measurement: 'unmeasurable' };
    }
    await writeAutoFitRecord(autoFitDirectoryOf(ports.home), record, ports.randomHex);
    const passed = autoGatePasses(record);
    ports.write(
      passed
        ? `classifier ${classifier} passed: false allows ${record.falseAllow.successes}/${record.falseAllow.trials}, upper bound ${(record.falseAllow.high * 100).toFixed(1)}%\n`
        : `classifier ${classifier} did not pass the measurement; auto mode stays selectable, and this is information, not a block\n`,
    );
    return { measurement: passed ? 'passed' : 'did_not_pass' };
  } finally {
    await homes.dispose();
  }
};

export const autoModeStatus = async (ports: AutoModeStatusPorts, options: AutoModeStatusOptions): Promise<AutoModeStatusOutcome> => {
  const classifier = classifierOf(ports.configuredClassifier, options.classifier);
  const key = await classifierKeyOf(ports.models, classifier, ports.platform, undefined);
  const view = autoFitViewOf(classifier, key, await readAutoFitRecord(autoFitDirectoryOf(ports.home), key));
  ports.write(`${autoModeNotice({ view, surface: options.surface })}\n`);
  return { measurement: view.measurement };
};

export const autoModeCheckPortsOf = async (ports: CliPorts, write: (text: string) => void): Promise<AutoModeCheckPorts> => {
  const { REFLECTION_ATTEMPTS_BOUND_MS, REFLECTION_PICKUP_BOUND_MS, REFLECTION_POLL_MS } = await import('@momonga/runtime');
  const models = loadUserModels({ home: ports.home });
  return {
    effects: nodeContextEffects(ports),
    models,
    configuredClassifier: models.autoModeClassifier,
    home: ports.home,
    version: ports.version,
    now: () => ports.clock.now(),
    randomHex: systemFileLockPorts.randomHex,
    reflection: { pendingBoundMs: REFLECTION_PICKUP_BOUND_MS, attemptBoundMs: REFLECTION_ATTEMPTS_BOUND_MS, pollMs: REFLECTION_POLL_MS },
    write,
  };
};

export const autoModeStatusPortsOf = (ports: CliPorts, write: (text: string) => void): AutoModeStatusPorts => {
  const models = loadUserModels({ home: ports.home });
  return { models, configuredClassifier: models.autoModeClassifier, home: ports.home, platform: ports.platform, write };
};
