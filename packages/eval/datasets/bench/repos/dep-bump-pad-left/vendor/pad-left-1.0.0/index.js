module.exports = (text, width, fill = ' ') => {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  return text.length >= width ? text : fill.repeat(width - text.length) + text;
};
