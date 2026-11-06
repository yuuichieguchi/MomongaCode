const { Store } = require('./deps.js').load('kv-store');

const store = new Store();
exports.save = (id, session) => store.set(id, session);
exports.load = (id, callback) => store.get(id, callback);
