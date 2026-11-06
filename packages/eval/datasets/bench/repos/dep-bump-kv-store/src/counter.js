const { Store } = require('./deps.js').load('kv-store');

const store = new Store();
exports.hit = (key, callback) => {
  store.get(key, (error, count) => {
    if (error) return callback(error);
    store.set(key, (count || 0) + 1);
    callback(null, (count || 0) + 1);
  });
};
