import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { renderObservable } from './ink-helpers.ts';

function Shown({ text }: { text: string | undefined }) {
  return text === undefined ? null : <Text>{text}</Text>;
}

describe('renderObservable', () => {
  it('records an empty frame the screen draws and not the flush probe of the output', async () => {
    const app = renderObservable(<Shown text="drawn" />);
    app.rerender(<Shown text={undefined} />);
    await new Promise<void>((resolve) => {
      app.stdout.write('', resolve);
    });
    expect(app.frames.at(0)).toBe('drawn');
    expect(app.frames.filter((frame) => frame === '')).toHaveLength(1);
    app.unmount();
  });
});
