const ignoresTerm = process.argv.includes('ignore-term');

if (ignoresTerm) {
  process.on('SIGTERM', () => {
    process.stderr.write('term\n');
  });
}
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => undefined);
process.stdin.resume();
setInterval(() => undefined, 1 << 30);
process.stderr.write('armed\n');
