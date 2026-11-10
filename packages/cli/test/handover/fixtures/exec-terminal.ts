import { spawnSync } from '@momonga/testkit/child-process';
import { hostReplace, replaceProcess } from '../../../src/handover/replace-process.ts';
import { handoverTarget, takeHandoverStart } from '../../../src/handover/start.ts';
import { startWithHandoverTerminal } from '../../../src/tui/terminal/handover.ts';
import { hostProcess, hostTerminalOutput } from '../../../src/tui/terminal/host.ts';
import { createTerminalLayer } from '../../../src/tui/terminal/layer.ts';

const RECORD = '/nonexistent/handover/session-1.json';

const ttyState = (): string => {
  const result = spawnSync('/bin/stty', ['-a'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' });
  const words = new Set(result.stdout.split(/\s+/));
  return `icanon=${words.has('-icanon') ? 'off' : 'on'} echo=${words.has('-echo') ? 'off' : 'on'}`;
};

const script = process.argv[1];
if (script === undefined) throw new Error('the fixture needs its own path');
const lose = process.argv.includes('lose-value');
const taken = takeHandoverStart(process.argv.slice(2), process.env, () => '{}');
const layer = createTerminalLayer({ input: process.stdin, output: hostTerminalOutput(process.stdout), process: hostProcess, screen: 'fullscreen', screenSetByUser: true, mouse: true, onEvents: () => undefined });

if (taken.started === undefined) {
  layer.start();
  layer.enable('mouse');
  const terminal = layer.handoverTerminal();
  hostTerminalOutput(process.stdout).writeSync(`before-exec pid=${process.pid} ${ttyState()}\r\n`);
  const target = handoverTarget({ self: { kind: 'script', execPath: process.execPath, script }, execArgv: process.execArgv, args: taken.args, env: process.env }, RECORD, lose ? undefined : terminal);
  layer.release();
  await replaceProcess(target, hostReplace, { release: () => undefined });
} else {
  const outcome = startWithHandoverTerminal(layer, taken.started.terminal, 'kitty');
  hostTerminalOutput(process.stdout).writeSync(`after-exec pid=${process.pid} ${outcome} enabled=${layer.state().enabled.join(',')} value=${String(process.env['MOMONGA_HANDOVER_TERMINAL'])} ${ttyState()}\r\n`);
  layer.close();
  process.exit(0);
}
