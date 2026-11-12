import type { AcceptedCheck, DeclaredCheck } from '@momonga/config';
import type { OverlayPorts } from './picker.tsx';

export const TYPE_CHECK_ROW = 'Type another command';
export const DECLINE_CHECK_ROW = 'Decline: runs in this folder stay unverified';

const QUESTION_TITLE = 'This folder declares a check';

const QUESTION_LINES = [
  'After a run changes files, MomongaCode runs the accepted check; a run is verified only when it passes.',
  'The answer is kept in your user settings for this folder.',
];

export const useCheckRow = (check: DeclaredCheck): string => `Use ${check.command} (from ${check.source})`;

const typedCheck = async (checks: readonly DeclaredCheck[], promptText: OverlayPorts['promptText']): Promise<AcceptedCheck | undefined> => {
  const [first] = checks;
  const typed = await promptText({
    title: 'The check command for this folder',
    ...(first === undefined ? {} : { initial: first.command }),
    validate: (text) => (text.trim() === '' ? 'Type a command, or leave to answer at the next start.' : undefined),
  });
  return typed === undefined ? undefined : { commands: [typed.trim()] };
};

export const askProjectCheck = async (
  checks: readonly DeclaredCheck[],
  { choose, promptText }: Pick<OverlayPorts, 'choose' | 'promptText'>,
): Promise<AcceptedCheck | undefined> => {
  const rows = [...checks.map(useCheckRow), TYPE_CHECK_ROW, DECLINE_CHECK_ROW];
  const choice = await choose({ title: QUESTION_TITLE, lines: QUESTION_LINES, rows: rows.map((label) => ({ label })), initial: 0, decideOn: 'enter', escape: 'back', filter: false });
  if (choice === undefined) return undefined;
  const chosen = checks[choice.index];
  if (chosen !== undefined) return { commands: [chosen.command] };
  return rows[choice.index] === TYPE_CHECK_ROW ? typedCheck(checks, promptText) : { declined: true };
};
