module.exports = (text, width, fill = ' ') => {
  const value = String(text);
  return value.length >= width ? value : fill.repeat(width - value.length) + value;
};
