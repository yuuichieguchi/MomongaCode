import { Text } from 'ink';

export type WaitingFacts = { starting: boolean; waiting: string | undefined; busy: boolean; reconnecting: boolean };

export const STARTING_TEXT = 'starting the momonga daemon…';

export const waitingText = (facts: WaitingFacts): string | undefined => {
  if (facts.starting) return STARTING_TEXT;
  const parts = [...(facts.waiting === undefined ? [] : [`waiting for ${facts.waiting}`]), ...(facts.busy ? ['working (esc to cancel)'] : []), ...(facts.reconnecting ? ['reconnecting…'] : [])];
  return parts.length === 0 ? undefined : parts.join(' · ');
};

export function WaitingRow({ text }: { text: string }) {
  return (
    <Text dimColor wrap="truncate">
      {text}
    </Text>
  );
}
