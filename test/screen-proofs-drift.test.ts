import { describe, expect, it } from 'vitest';
import { COPY_MAX_BYTES, INPUT_BOX_FRAME_ROWS, OSC52_MAX_RAW_BYTES, SUBAGENT_ROWS_MAX } from '../packages/cli/src/tui/screen/constants.ts';
import { contextPercentOf } from '../packages/cli/src/tui/screen/footer.tsx';
import { VIEWPORT_ROWS, allocate, panelRowsCap } from '../packages/cli/src/tui/screen/layout.ts';
import { osc52Of } from '../packages/cli/src/tui/screen/clipboard.ts';
import { createRowCache } from '../packages/cli/src/tui/screen/row-cache.ts';
import { extractSelection } from '../packages/cli/src/tui/screen/selection.ts';
import { createTranscriptStore } from '../packages/cli/src/tui/screen/store.ts';
import { sourceOf } from '../packages/cli/src/tui/screen/viewport.ts';
import { appendEntry } from '../packages/cli/src/tui/transcript.ts';
import { MIN_ROWS } from '../packages/cli/src/tui/terminal/constants.ts';
import { ROW_RENDERERS, ROW_SCHEDULE } from '../packages/cli/test/tui/screen-fakes.ts';
import { SCREEN_CONSTANTS, allocateWith, base64LengthWith, numberOps } from '../packages/verify/test/proofs/screen-model.ts';

const REQUEST_VALUES = [0, 1, 2, 7] as const;

describe('the screen proofs of packages/verify/test/proofs describe the code of the screen (design/cli-tui.md section 15.6)', () => {
  it('reads the constants the models use from the one module of the code', () => {
    expect({
      MIN_ROWS,
      INPUT_BOX_FRAME_ROWS,
      SUBAGENT_ROWS_MAX,
      VIEWPORT_ROWS,
      PANEL_KEEPS_ROWS: 10 - panelRowsCap(10),
      OSC52_MAX_RAW_BYTES,
      COPY_MAX_BYTES,
    }).toEqual({
      MIN_ROWS: SCREEN_CONSTANTS.MIN_ROWS,
      INPUT_BOX_FRAME_ROWS: SCREEN_CONSTANTS.INPUT_BOX_FRAME_ROWS,
      SUBAGENT_ROWS_MAX: SCREEN_CONSTANTS.SUBAGENT_ROWS_MAX,
      VIEWPORT_ROWS: SCREEN_CONSTANTS.VIEWPORT_ROWS,
      PANEL_KEEPS_ROWS: SCREEN_CONSTANTS.PANEL_KEEPS_ROWS,
      OSC52_MAX_RAW_BYTES: SCREEN_CONSTANTS.OSC52_MAX_RAW_BYTES,
      COPY_MAX_BYTES: SCREEN_CONSTANTS.COPY_MAX_BYTES,
    });
  });

  it('allocates the rows of the screen as the model of screen-rows does, at every sampled height and request vector', () => {
    for (let height = MIN_ROWS; height <= 40; height += 1) {
      for (const waiting of REQUEST_VALUES) {
        for (const inputRows of REQUEST_VALUES) {
          for (const menu of REQUEST_VALUES) {
            for (const subagents of REQUEST_VALUES) {
              for (const panel of [undefined, 0, 3, 50] as const) {
                const requests = { waiting, inputRows, invitation: menu % 2, menu, subagents, footerSecond: waiting % 2, lines: inputRows };
                const allocation = allocate(height, { ...requests, panel });
                const modelled = allocateWith(numberOps, height, requests, panel);
                expect(allocation).toEqual(modelled);
              }
            }
          }
        }
      }
    }
  });

  it('rounds the context percent as footer-percent states: 0 exactly when tokens x 200 < window, 0 for 0 tokens, monotone in tokens', () => {
    const broken: string[] = [];
    for (let window = 1; window <= 600; window += 1) {
      let previous = 0;
      for (let tokens = 0; tokens <= window; tokens += 1) {
        const percent = contextPercentOf(tokens, window) ?? Number.NaN;
        if ((percent === 0) !== (tokens * 200 < window) || percent < previous) broken.push(`${tokens}/${window}: ${percent}`);
        previous = percent;
      }
    }
    expect(broken).toEqual([]);
    for (const tokens of [1, 7, 1_000, 123_457, 2 ** 20]) {
      for (const window of [200 * tokens - 1, 200 * tokens, 200 * tokens + 1]) expect(contextPercentOf(tokens, window) === 0).toBe(tokens * 200 < window);
    }
  });

  it('writes an OSC 52 payload of the length copy-bounds states', () => {
    for (const size of [0, 1, 2, 3, 4, 100, OSC52_MAX_RAW_BYTES]) {
      const sequence = osc52Of('a'.repeat(size));
      expect(sequence.length - osc52Of('').length).toBe(base64LengthWith(numberOps, size));
    }
  });

  it('stops an extract at the cap and never returns more bytes of text than the cap, as copy-bounds states', () => {
    const store = createTranscriptStore();
    for (let index = 0; index < 40; index += 1) appendEntry(store, { kind: 'user', text: `line ${index} ${'x'.repeat(index * 3)}` });
    const source = sourceOf(store, createRowCache(ROW_RENDERERS, ROW_SCHEDULE), 30);
    const all = { anchor: { entryId: store.at(0).id, rowIndex: 0, col: 0 }, head: { entryId: store.at(39).id, rowIndex: 99, col: 99 } };
    for (const cap of [0, 1, 10, 100, 1_000, COPY_MAX_BYTES]) {
      const extract = extractSelection(source, all, cap);
      expect(Buffer.byteLength(extract.text, 'utf8')).toBeLessThanOrEqual(cap);
      if (!extract.complete) expect(extract.bytes).toBeGreaterThan(cap);
    }
  });
});
