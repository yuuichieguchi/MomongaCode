import { describe, expect, it, vi } from 'vitest';
import type { ReasoningCapability } from '@momonga/protocol';
import { startPlan, submitLine } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { pollUntil } from '@momonga/testkit';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SERVER = 'ollama-127.0.0.1-18477';
const THINK = `${SERVER}/think-c:latest`;
const PLAIN = `${SERVER}/plain-b:latest`;
const MORE = ['alpha-a', 'bravo-b', 'charlie-c', 'delta-d', 'echo-e', 'foxtrot-f', 'golf-g', 'hotel-h', 'india-i'].map((name) => `${SERVER}/${name}:latest`);
const MODELS = [THINK, PLAIN, ...MORE];
const REASONING: ReasoningCapability = { control: 'reasoning_effort', lowest: 'none' };


const HINT_AT: Readonly<Record<number, string>> = { 80: "enter to choose · up/down to move · type to filter · tab: also use at every…", 120: "enter to choose · up/down to move · type to filter · tab: also use at every start · esc: go back" };
const LIST_ROWS = [
  "Models",
  "a change applies from the next run",
  "filter:",
  "›  1. ollama-127.0.0.1-18477/think-c (current)  local",
  "   2. ollama-127.0.0.1-18477/plain-b            local",
  "   3. ollama-127.0.0.1-18477/alpha-a            local",
  "   4. ollama-127.0.0.1-18477/bravo-b            local",
  "   5. ollama-127.0.0.1-18477/charlie-c          local",
  "   6. ollama-127.0.0.1-18477/delta-d            local",
  "   7. ollama-127.0.0.1-18477/echo-e             local",
  "   8. ollama-127.0.0.1-18477/foxtrot-f          local",
  "   9. ollama-127.0.0.1-18477/golf-g             local",
  "  10. ollama-127.0.0.1-18477/hotel-h            local",
  "  11. ollama-127.0.0.1-18477/india-i            local",
  "  12. Model settings…"
];
const PICKER = ['Reasoning effort', '  1. none', '  2. minimal', '  3. low', '› 4. medium  in use', '  5. high', '  6. xhigh', 'up/down to move · enter to choose · tab: this session only · esc: go back'].join('\n');
const FOOTER_START: Readonly<Record<number, string>> = {
  80: 'mode: manual (shift+tab) · tokens: 0 · context: 0% · effort: medium',
  120: 'mode: manual (shift+tab) · tokens: 0 · context: 0% · ollama-127.0.0.1-18477/think-c (effort: medium)    ctrl+j: new line',
};
const FOOTER_PLAIN: Readonly<Record<number, string>> = {
  80: 'mode: manual (shift+tab) · tokens: 0 · context: 0%',
  120: 'mode: manual (shift+tab) · tokens: 0 · context: 0% · ollama-127.0.0.1-18477/plain-b                     ctrl+j: new line',
};
const LINE_PLAIN: Readonly<Record<number, readonly string[]>> = {
  80: ['model: ollama-127.0.0.1-18477/plain-b (effort: not available); applies from', 'the next run'],
  120: ['model: ollama-127.0.0.1-18477/plain-b (effort: not available); applies from the next run'],
};
const LINE_THINK: Readonly<Record<number, readonly string[]>> = {
  80: ['model: ollama-127.0.0.1-18477/think-c (effort: medium); applies from the next', 'run'],
  120: ['model: ollama-127.0.0.1-18477/think-c (effort: medium); applies from the next run'],
};

const rowsOf = (frame: string): string[] => frame.split('\n').map((line) => line.trimEnd());
const footerOf = (frame: string): string => rowsOf(frame).find((line) => line.startsWith('mode: ')) ?? '';
const blockOf = (frame: string, title: string, end: string): string => {
  const lines = rowsOf(frame).map((line) => line.replace(/^│ ?/, '').replace(/ *│$/, ''));
  const start = lines.indexOf(title);
  const last = lines.findIndex((line, index) => index > start && line.includes(end));
  return lines.slice(start, last + 1).join('\n');
};

const started = async (columns: number, options: { session?: string; reasoning?: boolean; modelPending?: Promise<void> } = {}) => {
  const run = await startPlan({ session: { model: options.session ?? THINK }, models: MODELS, billing: Object.fromEntries(MODELS.map((model) => [model, 'local' as const])), reasoning: options.reasoning === false ? {} : { [THINK]: REASONING }, ...(options.modelPending === undefined ? {} : { listedProbing: true, modelPending: options.modelPending }) }, {}, { columns, rows: 40 });
  await untilFrame(run.app, 'context: 0%');
  return run;
};

const lineOf = (frame: string, columns: number): string[] => {
  const lines = rowsOf(frame);
  const at = lines.findIndex((line) => line.startsWith('model: '));
  return lines.slice(at, at + (columns === 80 ? 2 : 1));
};

const listOf = async (app: Instance): Promise<string> => {
  await submitLine(app, '/model');
  return blockOf(await untilFrame(app, (frame) => frame.includes('Model settings…') && frame.includes('enter to choose')), 'Models', 'enter to choose');
};

describe('real-length server model names at real widths', () => {
  for (const columns of [80, 120]) {
    it(`the footer after start, ${columns} columns`, async () => {
      const { app } = await started(columns);
      expect(footerOf(await untilFrame(app, 'context: 0%'))).toBe(FOOTER_START[columns]);
      app.unmount();
    });

    it(`the /model list of 11 server rows before and after filtering, ${columns} columns`, async () => {
      const { app } = await started(columns);
      const before = await listOf(app);
      app.stdin.write('plain');
      const after = blockOf(await untilFrame(app, 'filter: plain'), 'Models', 'enter to choose');
      expect([before, after]).toEqual([[...LIST_ROWS, HINT_AT[columns]].join('\n'), ['Models', 'a change applies from the next run', 'filter: plain', '›  1. ollama-127.0.0.1-18477/plain-b            local', HINT_AT[columns]].join('\n')]);
      app.unmount();
    });

    it(`a switch to a model with no reasoning control: the line and the footer, ${columns} columns`, async () => {
      const { app } = await started(columns);
      await listOf(app);
      app.stdin.write(`${KEYS.down}${KEYS.enter}`);
      const frame = await untilOutput(app, (now) => rowsOf(now).some((line) => line.startsWith('model: ')));
      await pollUntil(() => footerOf(app.lastFrame() ?? '').length > 0, { description: 'footer', boundMs: 3000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect([lineOf(frame, columns), footerOf(app.lastFrame() ?? '')]).toEqual([LINE_PLAIN[columns], FOOTER_PLAIN[columns]]);
      app.unmount();
    });

    it(`a switch to a model with a reasoning control: picker, line and footer, ${columns} columns`, async () => {
      const { app } = await started(columns, { session: PLAIN });
      await listOf(app);
      app.stdin.write(`${KEYS.enter}`);
      const picker = blockOf(await untilFrame(app, (frame) => frame.includes('Reasoning effort') && frame.includes('up/down to move')), 'Reasoning effort', 'up/down to move');
      await new Promise((resolve) => setTimeout(resolve, 300));
      app.stdin.write(KEYS.tab);
      const frame = await untilOutput(app, (now) => rowsOf(now).some((line) => line.startsWith('model: ')));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect([picker, lineOf(frame, columns), footerOf(app.lastFrame() ?? '')]).toEqual([PICKER, LINE_THINK[columns], FOOTER_START[columns]]);
      app.unmount();
    });
  }

  const FOOTERS: Readonly<Record<number, readonly [string, string, string]>> = {
    120: ['mode: manual (shift+tab) · tokens: 0 · context: 0% · ollama-127.0.0.1-18477/think-c (effort: medium)    ctrl+j: new line', 'mode: manual (shift+tab) · tokens: 0 · context: 0% · ollama-127.0.0.1-18477/plain-b                     ctrl+j: new line', 'mode: manual (shift+tab) · tokens: 0 · context: unknown · ollama-127.0.0.1-18477/think-c                ctrl+j: new line'],
    80: ['mode: manual (shift+tab) · tokens: 0 · context: 0% · effort: medium', 'mode: manual (shift+tab) · tokens: 0 · context: 0%', 'mode: manual (shift+tab) · tokens: 0 · context: unknown'],
    60: ['mode: manual (shift+tab) · tokens: 0 · context: 0%', 'mode: manual (shift+tab) · tokens: 0 · context: 0%', 'mode: manual (shift+tab) · tokens: 0 · context: unknown'],
  };

  for (const columns of [120, 80, 60]) {
    it(`the footer names the session model with its effort, alone without a reasoning control, and alone while its capabilities are not read, ${columns} columns`, async () => {
      const shown: string[] = [];
      for (const session of [THINK, PLAIN]) {
        const { app } = await started(columns, { session });
        await new Promise((resolve) => setTimeout(resolve, 300));
        shown.push(footerOf(app.lastFrame() ?? ''));
        app.unmount();
      }
      const pending = Promise.withResolvers<void>();
      const { app } = await startPlan({ session: { model: THINK }, models: MODELS, billing: Object.fromEntries(MODELS.map((model) => [model, 'local' as const])), reasoning: { [THINK]: REASONING }, listedProbing: true, modelPending: pending.promise }, {}, { columns, rows: 40 });
      await untilFrame(app, 'mode: manual');
      await new Promise((resolve) => setTimeout(resolve, 300));
      shown.push(footerOf(app.lastFrame() ?? ''));
      pending.resolve();
      app.unmount();
      expect(shown).toEqual(FOOTERS[columns]);
    });
  }

  it('the working-run sentence at 80 columns', async () => {
    const { app, backend } = await started(80, { session: PLAIN });
    await submitLine(app, 'long task');
    await pollUntil(() => backend.started.length === 1, { description: 'run', boundMs: 3000 });
    await listOf(app);
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (frame) => frame.includes('Reasoning effort') && frame.includes('up/down to move'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    app.stdin.write(KEYS.tab);
    const frame = await untilOutput(app, (now) => rowsOf(now).some((line) => line.startsWith('model: ')));
    const lines = rowsOf(frame);
    const at = lines.findIndex((line) => line.startsWith('model: '));
    expect(lines.slice(at, at + 3)).toEqual(['model: ollama-127.0.0.1-18477/think-c (effort: medium); the run that is', 'working keeps ollama-127.0.0.1-18477/plain-b, the next run uses', 'ollama-127.0.0.1-18477/think-c']);
    app.unmount();
  });
});
