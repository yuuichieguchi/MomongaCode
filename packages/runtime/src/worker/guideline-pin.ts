import type { RunEvent } from '@momonga/protocol';
import type { Run, RuntimeStore } from '@momonga/store';

const GUIDELINE_PIN = 'guidelineVersion';

const pinnedVersionOf = (runId: string, events: readonly RunEvent[]): number | undefined => {
  const started = events.find((event) => event.type === 'run.started');
  if (started?.type !== 'run.started') throw new Error(`run ${runId} has no run.started event`);
  const version = started.pins[GUIDELINE_PIN];
  if (version !== undefined && typeof version !== 'number') throw new Error(`the guideline version pinned by run ${runId} is not a number`);
  return version;
};

export const guidelineVersionFor = (store: RuntimeStore, run: Run): number | undefined =>
  run.parentRunId === null ? store.guidelines.current()?.version : pinnedVersionOf(run.parentRunId, store.readRunEventsOfTypes(run.parentRunId, ['run.started']));

export const guidelineOf = (store: RuntimeStore, version: number | undefined): { version: number; text: string } | undefined => {
  if (version === undefined) return undefined;
  const found = store.guidelines.get(version);
  if (found === undefined) throw new Error(`the guideline version ${version} pinned by a run does not exist`);
  return { version, text: found.text };
};
