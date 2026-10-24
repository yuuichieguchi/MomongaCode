const trapTerm = process.env['P3_TRAP_TERM'] === '1';

process.on('SIGTERM', () => {
  process.stdout.write('TERM\n');
  if (!trapTerm) process.exit(143);
});

const keepAlive = setInterval(() => undefined, 60_000);

process.stdin.on('data', () => undefined);
process.stdin.on('end', () => {
  clearInterval(keepAlive);
  process.exit(0);
});

process.stdout.write('ready\n');
