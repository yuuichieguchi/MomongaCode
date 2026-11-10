import fs from 'node:fs';

const [events = '', name = '', release = ''] = process.argv.slice(2);

fs.appendFileSync(events, `${name} start\n`);
const timer = setInterval(() => {
  if (!fs.existsSync(release)) return;
  clearInterval(timer);
  fs.appendFileSync(events, `${name} end\n`);
}, 10);
