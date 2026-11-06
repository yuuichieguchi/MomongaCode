const padLeft = require('./deps.js').load('pad-left');

exports.ticketNumber = (value) => padLeft(value, 6, '0');
