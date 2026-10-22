import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };

new Command().name('momonga').version(packageJson.version).parse();
