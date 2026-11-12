import type { TestContext } from 'vitest';
import type { GatewayHealth, LocalServerDetection, PlanAccountsResponse } from '@momonga/protocol';
import type { DetectRequest } from '../src/commands/models.ts';
import { createFoundServers } from '../src/tui/models/context.ts';
import type { ModelsFlowContext } from '../src/tui/models/context.ts';
import type { PickRequest, TextRequest } from '../src/tui/picker.tsx';
import { bytesOf, documentOf, homeWith, shellOf } from './models-shell-harness.ts';
import type { ShellHome } from './models-shell-harness.ts';

export type Step = { readonly pick: string | RegExp; readonly alt?: boolean } | { readonly type: string } | { readonly leave: true };

export type Shown =
  | { readonly kind: 'pick'; readonly title: string | undefined; readonly lines: readonly string[]; readonly rows: readonly string[] }
  | { readonly kind: 'text'; readonly title: string; readonly hidden: boolean; readonly problems: readonly string[] };

export type FlowFakes = {
  found?: (request: DetectRequest) => readonly LocalServerDetection[] | Promise<readonly LocalServerDetection[]>;
  programModel?: string;
  health?: GatewayHealth['models'];
  accounts?: PlanAccountsResponse;
  cancelPhase?: string;
  model?: string;
};

export type FlowHarness = {
  context: ModelsFlowContext;
  place: ShellHome;
  shown: Shown[];
  infos: string[];
  phases: string[];
  detections: DetectRequest[];
  listings: number[];
  secrets: Map<string, string>;
  written(): Record<string, unknown>;
  bytes(): string | undefined;
  picks(): Extract<Shown, { kind: 'pick' }>[];
  prompts(): Extract<Shown, { kind: 'text' }>[];
  unused(): readonly Step[];
};

const lineText = (line: NonNullable<PickRequest['lines']>[number]): string => (typeof line === 'string' ? line : line.text);

const matches = (label: string, wanted: string | RegExp): boolean => (typeof wanted === 'string' ? label === wanted || label.trim() === wanted : wanted.test(label.trim()));

export const flowOf = (context: TestContext, settings: unknown | undefined, steps: readonly Step[], fakes: FlowFakes = {}): FlowHarness => {
  const place = homeWith(context, settings);
  const pending = [...steps];
  const shown: Shown[] = [];
  const infos: string[] = [];
  const phases: string[] = [];
  const secrets = new Map<string, string>();
  const detections: DetectRequest[] = [];
  const harness = shellOf(place, { ...(fakes.programModel === undefined ? {} : { programModel: fakes.programModel }) });
  const choose = async (request: PickRequest) => {
    const rows = request.rows.map((row) => row.label);
    shown.push({ kind: 'pick', title: request.title, lines: (request.lines ?? []).map(lineText), rows });
    const step = pending.shift();
    if (step === undefined || 'leave' in step) return undefined;
    if (!('pick' in step)) throw new Error(`the screen shows the list "${request.title ?? ''}" and the script types ${JSON.stringify(step)}`);
    const index = request.rows.findIndex((row) => row.separator !== true && row.disabled !== true && matches(row.label, step.pick));
    if (index < 0) throw new Error(`the list "${request.title ?? ''}" has no row ${String(step.pick)}; rows: ${rows.join(' | ')}`);
    return { index, alt: step.alt === true };
  };
  const promptText = async (request: TextRequest) => {
    const problems: string[] = [];
    const entry: Shown = { kind: 'text', title: request.title, hidden: request.hidden === true, problems };
    shown.push(entry);
    for (;;) {
      const step = pending.shift();
      if (step === undefined || 'leave' in step) return undefined;
      if (!('type' in step)) throw new Error(`the screen asks "${request.title}" and the script picks ${JSON.stringify(step)}`);
      const problem = request.validate(step.type);
      if (problem === undefined) return step.type;
      problems.push(problem);
    }
  };
  const flow: ModelsFlowContext = {
    backend: {
      modelList: () => harness.shell.listing(),
      modelsHost: (signal) => ({
        home: harness.shell.home,
        settingsFile: harness.shell.settingsFile,
        lock: harness.shell.lock,
        platform: harness.shell.platform,
        files: harness.shell.files,
        interrupt: signal,
        listing: harness.shell.listing,
        detect: async (request) => {
          detections.push(request);
          return fakes.found === undefined ? [] : fakes.found(request);
        },
        programModel: harness.shell.programModel,
        describe: harness.shell.describe,
      }),
      storeSecret: async (name, value) => void secrets.set(name, value),
      health: async () => ({ ok: true, models: fakes.health ?? {}, version: '0.0.0', apiVersion: 1, pid: 1, startedAt: '2026-11-10T00:00:00.000Z', state: 'running', activeRequests: 0 }),
      plan: { accounts: async () => fakes.accounts ?? { profiles: [], accounts: [] } } as ModelsFlowContext['backend']['plan'],
    },
    overlays: { choose, promptText },
    found: createFoundServers(),
    model: fakes.model,
    info: (text) => void infos.push(text),
    wait: (phase, work) => {
      phases.push(phase);
      const controller = new AbortController();
      const running = work(controller.signal);
      if (phase === fakes.cancelPhase) controller.abort(new Error('cancelled'));
      return running;
    },
  };
  return {
    context: flow,
    place,
    shown,
    infos,
    phases,
    detections,
    listings: harness.listings,
    secrets,
    written: () => documentOf(place.settingsFile),
    bytes: () => bytesOf(place.settingsFile),
    picks: () => shown.filter((entry): entry is Extract<Shown, { kind: 'pick' }> => entry.kind === 'pick'),
    prompts: () => shown.filter((entry): entry is Extract<Shown, { kind: 'text' }> => entry.kind === 'text'),
    unused: () => pending,
  };
};

export const YES: Step = { pick: 'Yes' };
export const NO: Step = { pick: 'No' };

export const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
