import fs from 'node:fs';
import path from 'node:path';

const [events = '', name = '', release = ''] = process.argv.slice(2);
const polledDirectory = path.dirname(release);

fs.appendFileSync(events, `${name} start\n`);
const timer = setInterval(() => {
  if (!fs.existsSync(polledDirectory)) {
    clearInterval(timer);
    return;
  }
  if (!fs.existsSync(release)) return;
  clearInterval(timer);
  fs.appendFileSync(events, `${name} end\n`);
}, 10);
