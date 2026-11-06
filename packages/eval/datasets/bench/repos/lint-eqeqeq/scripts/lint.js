const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lint.config.json'), 'utf8'));
const RULES = {
  'no-var': (line) => /^\s*var\s/.test(line),
  eqeqeq: (line) => /(^|[^=!<>])==(?!=)|!=(?!=)/.test(line),
  'no-trailing-spaces': (line) => /[ \t]+$/.test(line),
};
const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
let problems = 0;
for (const file of filesIn(path.join(__dirname, '..', 'src')).filter((name) => name.endsWith('.js'))) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    for (const rule of config.rules) {
      if (RULES[rule](line)) { console.error(`${path.relative(process.cwd(), file)}:${index + 1} ${rule}`); problems += 1; }
    }
  });
}
process.exit(problems === 0 ? 0 : 1);
