import { INPUT_BOX_FRAME_ROWS, SUBAGENT_ROWS_MAX } from './constants.ts';

export type RowRequests = { waiting: number; inputRows: number; menu: number; subagents: number; footerSecond: number; lines: number; panel: number | undefined };

export type RowAllocation = { viewport: number; menu: number; waiting: number; lines: number; input: number; footer: number; subagents: number };

export const REGIONS = ['viewport', 'menu', 'waiting', 'lines', 'input', 'footer', 'subagents'] as const;

export type Region = (typeof REGIONS)[number];

const FOOTER_ROWS = 1;
const VIEWPORT_ROWS = 1;
const PANEL_KEEPS_ROWS = 4;

export const inputRowsCap = (height: number): number => Math.max(1, Math.floor(height / 3));

export const menuRowsCap = (height: number): number => Math.floor(height / 3);

export const subagentRowsCap = (height: number): number => Math.min(SUBAGENT_ROWS_MAX, Math.floor(height / 6));

export const panelRowsCap = (height: number): number => height - PANEL_KEEPS_ROWS;

export const allocate = (height: number, requests: RowRequests): RowAllocation => {
  const panel = requests.panel === undefined ? undefined : Math.min(requests.panel, panelRowsCap(height));
  const reservedInput = panel ?? INPUT_BOX_FRAME_ROWS + 1;
  let left = height - FOOTER_ROWS - VIEWPORT_ROWS - reservedInput;
  const take = (request: number): number => {
    const given = Math.max(0, Math.min(request, left));
    left -= given;
    return given;
  };
  const waiting = take(requests.waiting);
  const inputExtra = panel === undefined ? take(Math.min(requests.inputRows, inputRowsCap(height)) - 1) : 0;
  const menu = panel === undefined ? take(Math.min(requests.menu, menuRowsCap(height))) : 0;
  const subagents = take(Math.min(requests.subagents, subagentRowsCap(height)));
  const footerSecond = take(requests.footerSecond);
  const lines = panel === undefined ? take(requests.lines) : 0;
  return { viewport: VIEWPORT_ROWS + left, menu, waiting, lines, input: reservedInput + inputExtra, footer: FOOTER_ROWS + footerSecond, subagents };
};

export const regionAt = (rows: RowAllocation, screenRow: number): { region: Region; row: number } | undefined => {
  let top = 1;
  for (const region of REGIONS) {
    if (screenRow >= top && screenRow < top + rows[region]) return { region, row: screenRow - top };
    top += rows[region];
  }
  return undefined;
};
