import fs from 'node:fs';

const [released, code] = process.argv.slice(2);
process.exit(fs.existsSync(released) ? Number(code) : 3);
