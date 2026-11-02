import path from 'node:path';
import { Box, Text, useWindowSize } from 'ink';

export type StartupConfig = { version: string; home: string; color: boolean };

export type StartupModel = { alias: string; targets: readonly string[] | undefined };

const FUR = '#a9744f';
const MEMBRANE = '#7fb2c9';
const FACE = '#f1dfc4';

const ART: readonly (readonly { text: string; color?: string }[])[] = [
  [{ text: '      ' }, { text: '∩   ∩', color: FUR }],
  [{ text: '  ' }, { text: '╭───', color: MEMBRANE }, { text: '(', color: FUR }, { text: '•ᴥ•', color: FACE }, { text: ')', color: FUR }, { text: '───╮', color: MEMBRANE }],
  [{ text: ' ' }, { text: '╭╯░░░░░░░░░░░╰╮', color: MEMBRANE }],
  [{ text: ' ' }, { text: '╰╮░░░░░░░░░░░╭╯', color: MEMBRANE }],
  [{ text: '  ' }, { text: '╰─╯ ╰─', color: MEMBRANE }, { text: '┬', color: FUR }, { text: '─╯ ╰─╯', color: MEMBRANE }],
  [{ text: '        ' }, { text: '╰╮', color: FUR }],
];

const lengthOfRow = (row: readonly { text: string }[]): number => row.reduce((total, part) => total + [...part.text].length, 0);

export const ART_WIDTH = Math.max(...ART.map(lengthOfRow));

export const ART_GAP = 2;

const BOX_CHROME_COLUMNS = 4;

export const shortenHome = (cwd: string, home: string): string => {
  if (cwd === home) return '~';
  return cwd.startsWith(`${home}${path.sep}`) ? `~${cwd.slice(home.length)}` : cwd;
};

export const textLines = (config: StartupConfig, model: StartupModel, mode: string, cwd: string): string[] => [
  `MomongaCode v${config.version}`,
  `model: ${model.alias}${model.targets === undefined ? '' : ` → ${model.targets.join(', ')}`}`,
  `mode: ${mode}`,
  shortenHome(cwd, config.home),
];

export const artFits = (columns: number, lines: readonly string[]): boolean =>
  columns >= ART_WIDTH + ART_GAP + Math.max(...lines.map((line) => [...line].length)) + BOX_CHROME_COLUMNS;

const colorProps = (color: string | undefined, enabled: boolean): { color?: string } => (enabled && color !== undefined ? { color } : {});

export function StartupScreen(props: { config: StartupConfig; model: StartupModel; mode: string; cwd: string; notices: readonly string[] }) {
  const { config, model, mode, cwd, notices } = props;
  const { columns } = useWindowSize();
  const lines = textLines(config, model, mode, cwd);
  const showArt = artFits(columns, lines);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} {...(config.color ? { borderColor: '#a9744f' } : {})}>
      <Box>
        {showArt ? (
          <Box flexDirection="column" marginRight={ART_GAP}>
            {ART.map((row, index) => (
              <Text key={index}>
                {row.map((part, partIndex) => (
                  <Text key={partIndex} {...colorProps(part.color, config.color)}>
                    {part.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box flexDirection="column">
          <Text bold>{lines[0]}</Text>
          <Text>{lines[1]}</Text>
          <Text>{lines[2]}</Text>
          <Text dimColor>{lines[3]}</Text>
        </Box>
      </Box>
      {notices.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          {notices.map((notice, index) => (
            <Text key={index} {...colorProps('yellow', config.color)}>{`! ${notice}`}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
