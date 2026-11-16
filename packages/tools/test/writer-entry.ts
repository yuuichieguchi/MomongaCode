import { runFileWriter } from '../src/executable-helpers.ts';

process.exitCode = await runFileWriter({ args: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
