'use strict';

const SHORTEST = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

function decimalOf(value) {
  const match = SHORTEST.exec(String(Math.abs(value)));
  const fraction = match[2] === undefined ? '' : match[2];
  const exponent = (match[3] === undefined ? 0 : Number(match[3])) - fraction.length;
  return { digits: BigInt(match[1] + fraction), exponent };
}

function multipleOfOk(data, divisor) {
  if (!Number.isFinite(data) || !Number.isFinite(divisor) || divisor === 0) return false;
  const a = decimalOf(data);
  const b = decimalOf(divisor);
  const scale = Math.min(a.exponent, b.exponent);
  const dividend = a.digits * 10n ** BigInt(a.exponent - scale);
  const step = b.digits * 10n ** BigInt(b.exponent - scale);
  return dividend % step === 0n;
}

module.exports = { multipleOfOk };
