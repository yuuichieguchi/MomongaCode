const manifest = require('../package.json');

exports.load = (name) => require(`../vendor/${name}-${manifest.vendored[name]}`);
