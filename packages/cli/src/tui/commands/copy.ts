import { copyMessage } from '../screen/clipboard.ts';
import type { SlashCommand } from '../slash.ts';

export const NOTHING_TO_COPY = 'Nothing to copy: select text on the screen, or wait for an answer.';

export const copyCommand: SlashCommand = {
  name: 'copy',
  needsSession: false,
  description: 'copy the selected text, or the last answer when nothing is selected, to the clipboard',
  run: async (_args, context) => {
    const selected = context.clipboard.selected();
    if (selected?.kind === 'too-large') {
      context.toast(copyMessage({ kind: 'too-large', bytes: selected.bytes, through: 'any' }));
      return;
    }
    const text = selected?.text ?? context.clipboard.lastAnswer();
    if (text === undefined || text === '') {
      context.info(NOTHING_TO_COPY);
      return;
    }
    context.toast(copyMessage(await context.backend.copyToClipboard(text)));
  },
};
