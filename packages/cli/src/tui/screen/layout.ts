import { INPUT_BOX_FRAME_ROWS, SUBAGENT_ROWS_MAX } from './constants.ts';

export type RowRequests = { header: number; waiting: number; inputRows: number; invitation: number; menu: number; subagents: number; footerSecond: number; lines: number; panel: number | undefined };

export type RowAllocation = { header: number; viewport: number; menu: number; waiting: number; lines: number; input: number; footer: number; subagents: number };

export const REGIONS = ['header', 'viewport', 'menu', 'waiting', 'lines', 'input', 'footer', 'subagents'] as const;

export type Region = (typeof REGIONS)[number];

const FOOTER_ROWS = 1;
export const VIEWPORT_ROWS = 1;
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
  const inputExtra = panel === undefined ? take(Math.min(requests.inputRows, inputRowsCap(height)) - 1) : 0;
  const subagents = take(Math.min(requests.subagents, subagentRowsCap(height)));
  const footerSecond = take(requests.footerSecond);
  const header = take(requests.header);
  const invitation = panel === undefined ? take(requests.invitation) : 0;
  const waiting = take(requests.waiting);
  const menu = invitation + (panel === undefined ? take(Math.min(requests.menu, menuRowsCap(height))) : 0);
  const lines = take(requests.lines);
  return { header, viewport: VIEWPORT_ROWS + left, menu, waiting, lines, input: reservedInput + inputExtra, footer: FOOTER_ROWS + footerSecond, subagents };
};

export const drawnTranscriptRows = (viewport: number, held: number): number => Math.max(VIEWPORT_ROWS, Math.min(viewport, held));

export type RowsAboveInput = Pick<RowAllocation, 'header' | 'viewport' | 'menu' | 'waiting' | 'lines'>;

export const naturalRows = (transcript: number, requests: Pick<RowRequests, 'header' | 'waiting' | 'invitation' | 'menu' | 'lines'>): RowsAboveInput => ({ header: requests.header, viewport: transcript, menu: requests.invitation + requests.menu, waiting: requests.waiting, lines: requests.lines });

export const inputTopOf = (rows: RowsAboveInput): number => rows.header + rows.viewport + rows.menu + rows.waiting + rows.lines;

export const regionAt = (rows: RowAllocation, screenRow: number): { region: Region; row: number } | undefined => {
  let top = 1;
  for (const region of REGIONS) {
    if (screenRow >= top && screenRow < top + rows[region]) return { region, row: screenRow - top };
    top += rows[region];
  }
  return undefined;
};
