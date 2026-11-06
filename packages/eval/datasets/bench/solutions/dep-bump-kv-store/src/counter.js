const { Store } = require('./deps.js').load('kv-store');

const store = new Store();
exports.hit = (key, callback) => {
  store.read(key).then((count) => {
    store.set(key, (count || 0) + 1);
    callback(null, (count || 0) + 1);
  }, callback);
};
