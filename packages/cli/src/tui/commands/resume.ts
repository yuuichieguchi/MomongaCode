import type { ListedSession, TuiBackend } from '../backend.ts';
import type { PickRequest } from '../picker.tsx';
import { displayWidth, segmentsOf } from '../screen/wrap.ts';
import type { SlashCommand } from '../slash.ts';

export const RESUME_PICKER_TITLE = 'Resume a conversation';

export const noEarlierConversation = (cwd: string): string => `No earlier conversation in ${cwd}.`;

const ROW_MARGIN_COLUMNS = 8;
const CUT_MARK = '…';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const ageText = (createdAt: number, now: number): string => {
  const age = Math.max(0, now - createdAt);
  if (age < MINUTE_MS) return 'just now';
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h ago`;
  return `${Math.floor(age / DAY_MS)}d ago`;
};

const cutTo = (text: string, columns: number): string => {
  if (displayWidth(text) <= columns) return text;
  const room = Math.max(0, columns - displayWidth(CUT_MARK));
  let used = 0;
  let kept = '';
  for (const { segment, width } of segmentsOf(text)) {
    if (used + width > room) break;
    used += width;
    kept += segment;
  }
  return `${kept}${CUT_MARK}`;
};

export const conversationRow = (listed: ListedSession, now: number, columns: number): string => {
  const facts = ` · ${ageText(listed.createdAt, now)} · ${listed.runs} ${listed.runs === 1 ? 'run' : 'runs'}`;
  return `${cutTo(listed.firstPrompt.replaceAll(/\s+/g, ' ').trim(), columns - ROW_MARGIN_COLUMNS - displayWidth(facts))}${facts}`;
};

export type ResumePorts = {
  backend: Pick<TuiBackend, 'sessions' | 'cwd'>;
  pick(request: PickRequest): Promise<number | undefined>;
  info(text: string): void;
  resume(id: string): Promise<void>;
  now(): number;
  columns(): number;
};

export const pickConversation = async (ports: ResumePorts): Promise<void> => {
  const listed = await ports.backend.sessions();
  if (listed.length === 0) {
    ports.info(noEarlierConversation(ports.backend.cwd));
    return;
  }
  const now = ports.now();
  const columns = ports.columns();
  const index = await ports.pick({ title: RESUME_PICKER_TITLE, rows: listed.map((session) => ({ label: conversationRow(session, now, columns) })), decideOn: 'enter', escape: 'back', filter: true });
  const chosen = index === undefined ? undefined : listed[index];
  if (chosen !== undefined) await ports.resume(chosen.id);
};

export const resumeCommand: SlashCommand = {
  name: 'resume',
  usage: '[session-id]',
  description: 'reopen an earlier conversation of this folder; without an id, choose from a list',
  run: async (args, context) => {
    if (args !== '') {
      await context.sessions.resume(args);
      return;
    }
    await pickConversation({ backend: context.backend, pick: context.display.pick, info: context.info, resume: context.sessions.resume, now: context.sessions.now, columns: context.sessions.columns });
  },
};
