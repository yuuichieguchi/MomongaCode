import packageJson from '../package.json' with { type: 'json' };
import { runMain } from './run-main.ts';

await runMain(packageJson.version);
