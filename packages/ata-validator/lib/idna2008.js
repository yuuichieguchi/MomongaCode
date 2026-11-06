'use strict';
const tables = require('./idna2008-tables');

const EXCEPTIONS = new Map([
  [0x00df, 'PVALID'], [0x03c2, 'PVALID'], [0x06fd, 'PVALID'], [0x06fe, 'PVALID'], [0x0f0b, 'PVALID'], [0x3007, 'PVALID'],
  [0x00b7, 'CONTEXTO'], [0x0375, 'CONTEXTO'], [0x05f3, 'CONTEXTO'], [0x05f4, 'CONTEXTO'], [0x30fb, 'CONTEXTO'],
  [0x0640, 'DISALLOWED'], [0x07fa, 'DISALLOWED'], [0x302e, 'DISALLOWED'], [0x302f, 'DISALLOWED'], [0x303b, 'DISALLOWED'],
]);
for (let cp = 0x0660; cp <= 0x0669; cp++) EXCEPTIONS.set(cp, 'CONTEXTO');
for (let cp = 0x06f0; cp <= 0x06f9; cp++) EXCEPTIONS.set(cp, 'CONTEXTO');
for (let cp = 0x3031; cp <= 0x3035; cp++) EXCEPTIONS.set(cp, 'DISALLOWED');

const UNASSIGNED = /^\p{Cn}$/u;
const IGNORABLE = /^[\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Noncharacter_Code_Point}]$/u;
const UNSTABLE = /^\p{Changes_When_NFKC_Casefolded}$/u;
const LETTER_DIGIT = /^[\p{Ll}\p{Lu}\p{Lo}\p{Nd}\p{Lm}\p{Mn}\p{Mc}]$/u;
const MARK = /^\p{M}$/u;
const GREEK = /^\p{Script=Greek}$/u;
const HEBREW = /^\p{Script=Hebrew}$/u;
const KANA_OR_HAN = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]$/u;
const IGNORABLE_BLOCKS = [[0x20d0, 0x20ff], [0x1d100, 0x1d1ff], [0x1d200, 0x1d24f]];

function inRanges(flat, cp) {
  let low = 0;
  let high = (flat.length >> 1) - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < flat[mid * 2]) high = mid - 1;
    else if (cp > flat[mid * 2 + 1]) low = mid + 1;
    else return true;
  }
  return false;
}

function derivedProperty(cp) {
  const exception = EXCEPTIONS.get(cp);
  if (exception !== undefined) return exception;
  const character = String.fromCodePoint(cp);
  if (UNASSIGNED.test(character)) return 'UNASSIGNED';
  if (cp === 0x2d || (cp >= 0x30 && cp <= 0x39) || (cp >= 0x61 && cp <= 0x7a)) return 'PVALID';
  if (cp === 0x200c || cp === 0x200d) return 'CONTEXTJ';
  if (inRanges(tables.OLD_HANGUL_JAMO, cp)) return 'DISALLOWED';
  if (UNSTABLE.test(character)) return 'DISALLOWED';
  if (IGNORABLE.test(character)) return 'DISALLOWED';
  for (const [low, high] of IGNORABLE_BLOCKS) if (cp >= low && cp <= high) return 'DISALLOWED';
  return LETTER_DIGIT.test(character) ? 'PVALID' : 'DISALLOWED';
}

const joiningType = (cp) =>
  inRanges(tables.JOINING_D, cp) ? 'D' : inRanges(tables.JOINING_L, cp) ? 'L' : inRanges(tables.JOINING_R, cp) ? 'R' : inRanges(tables.JOINING_T, cp) ? 'T' : 'U';

function zeroWidthNonJoinerOk(cps, index) {
  if (index > 0 && inRanges(tables.VIRAMA, cps[index - 1])) return true;
  let left = index - 1;
  while (left >= 0 && joiningType(cps[left]) === 'T') left--;
  if (left < 0 || (joiningType(cps[left]) !== 'L' && joiningType(cps[left]) !== 'D')) return false;
  let right = index + 1;
  while (right < cps.length && joiningType(cps[right]) === 'T') right++;
  return right < cps.length && (joiningType(cps[right]) === 'R' || joiningType(cps[right]) === 'D');
}

function contextOk(cps, index) {
  const cp = cps[index];
  const text = (at) => (at >= 0 && at < cps.length ? String.fromCodePoint(cps[at]) : '');
  switch (cp) {
    case 0x200c: return zeroWidthNonJoinerOk(cps, index);
    case 0x200d: return index > 0 && inRanges(tables.VIRAMA, cps[index - 1]);
    case 0x00b7: return cps[index - 1] === 0x6c && cps[index + 1] === 0x6c;
    case 0x0375: return GREEK.test(text(index + 1));
    case 0x05f3: case 0x05f4: return HEBREW.test(text(index - 1));
    case 0x30fb: return cps.some((other, at) => at !== index && KANA_OR_HAN.test(String.fromCodePoint(other)));
    default:
      if (cp >= 0x0660 && cp <= 0x0669) return !cps.some((other) => other >= 0x06f0 && other <= 0x06f9);
      return !cps.some((other) => other >= 0x0660 && other <= 0x0669);
  }
}

function uLabelOk(label) {
  if (label.length > MAX_LABEL_UNITS) return false;
  const cps = Array.from(label, (character) => character.codePointAt(0));
  if (cps.length === 0 || label !== label.normalize('NFC')) return false;
  if (MARK.test(String.fromCodePoint(cps[0]))) return false;
  if (cps[0] === 0x2d || cps[cps.length - 1] === 0x2d || (cps.length >= 4 && cps[2] === 0x2d && cps[3] === 0x2d)) return false;
  for (let index = 0; index < cps.length; index++) {
    const property = derivedProperty(cps[index]);
    if (property === 'PVALID') continue;
    if ((property === 'CONTEXTJ' || property === 'CONTEXTO') && contextOk(cps, index)) continue;
    return false;
  }
  return true;
}

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;
const MAX_LABEL_OCTETS = 63;
const MAX_NAME_OCTETS = 253;
const MAX_LABEL_UNITS = 2 * MAX_LABEL_OCTETS;
const MAX_MAPPED_UNITS = 2 * MAX_NAME_OCTETS;

function adapt(delta, points, first) {
  let k = 0;
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

const digitValue = (code) => (code >= 0x30 && code <= 0x39 ? code - 22 : code >= 0x41 && code <= 0x5a ? code - 0x41 : code >= 0x61 && code <= 0x7a ? code - 0x61 : BASE);
const digitChar = (digit) => String.fromCharCode(digit + 22 + (digit < 26 ? 75 : 0));

function punycodeDecode(input) {
  const output = [];
  const basicEnd = input.lastIndexOf('-');
  for (let index = 0; index < Math.max(basicEnd, 0); index++) {
    if (input.charCodeAt(index) >= 0x80) return null;
    output.push(input.charCodeAt(index));
  }
  let n = INITIAL_N;
  let i = 0;
  let bias = INITIAL_BIAS;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitValue(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (Math.floor(i / out) > MAX_INT - n) return null;
    n += Math.floor(i / out);
    i %= out;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i++, 0, n);
  }
  let text = '';
  for (const cp of output) text += String.fromCodePoint(cp);
  return text;
}

function punycodeEncode(label) {
  const cps = Array.from(label, (character) => character.codePointAt(0));
  const basic = cps.filter((cp) => cp < 0x80);
  let output = '';
  for (const cp of basic) output += String.fromCharCode(cp);
  let handled = basic.length;
  if (basic.length > 0) output += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < cps.length) {
    let next = MAX_INT;
    for (const cp of cps) if (cp >= n && cp < next) next = cp;
    delta += (next - n) * (handled + 1);
    n = next;
    for (const cp of cps) {
      if (cp < n) delta++;
      if (cp !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
        if (q < t) break;
        output += digitChar(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      output += digitChar(q);
      bias = adapt(delta, handled + 1, handled === basic.length);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return output;
}

const ACE_PREFIX = /^xn--/i;
const ASCII_ONLY = /^[\x00-\x7f]*$/;

function uLabelOfALabel(label) {
  if (label.length > MAX_LABEL_OCTETS) return null;
  const body = label.slice(4);
  const decoded = punycodeDecode(body);
  if (decoded === null || ASCII_ONLY.test(decoded) || !uLabelOk(decoded)) return null;
  return punycodeEncode(decoded).toLowerCase() === body.toLowerCase() ? decoded : null;
}

const isRtlClass = (cp) => inRanges(tables.BIDI_R, cp) || inRanges(tables.BIDI_AL, cp);

function bidiLabelOk(cps) {
  const first = cps[0];
  if (isRtlClass(first)) {
    let sawEn = false;
    let sawAn = false;
    for (const cp of cps) {
      if (!(isRtlClass(cp) || inRanges(tables.BIDI_AN, cp) || inRanges(tables.BIDI_EN, cp) || inRanges(tables.BIDI_NSM, cp) || inRanges(tables.BIDI_NEUTRAL, cp))) return false;
      if (inRanges(tables.BIDI_EN, cp)) sawEn = true;
      if (inRanges(tables.BIDI_AN, cp)) sawAn = true;
    }
    if (sawEn && sawAn) return false;
    let last = cps.length - 1;
    while (last > 0 && inRanges(tables.BIDI_NSM, cps[last])) last--;
    const end = cps[last];
    return isRtlClass(end) || inRanges(tables.BIDI_EN, end) || inRanges(tables.BIDI_AN, end);
  }
  if (inRanges(tables.BIDI_EN, first) || inRanges(tables.BIDI_AN, first) || inRanges(tables.BIDI_NSM, first) || inRanges(tables.BIDI_NEUTRAL, first)) return false;
  for (const cp of cps) if (isRtlClass(cp) || inRanges(tables.BIDI_AN, cp)) return false;
  let last = cps.length - 1;
  while (last > 0 && inRanges(tables.BIDI_NSM, cps[last])) last--;
  const end = cps[last];
  return !(isRtlClass(end) || inRanges(tables.BIDI_AN, end) || inRanges(tables.BIDI_NEUTRAL, end) || inRanges(tables.BIDI_NSM, end));
}

function bidiDomainOk(labels) {
  const all = labels.map((label) => Array.from(label, (character) => character.codePointAt(0)));
  if (!all.some((cps) => cps.some((cp) => isRtlClass(cp) || inRanges(tables.BIDI_AN, cp)))) return true;
  return all.every(bidiLabelOk);
}

function aceLength(uLabel) {
  if (uLabel.length > MAX_LABEL_UNITS) return MAX_LABEL_OCTETS + 1;
  return ASCII_ONLY.test(uLabel) ? uLabel.length : 4 + punycodeEncode(uLabel).length;
}

function uLabelOfAny(label) {
  if (ACE_PREFIX.test(label)) return uLabelOfALabel(label);
  return uLabelOk(label) ? label : null;
}

function hostnameLabelsOk(hostname) {
  const labels = hostname.split('.');
  if (!labels.some((label) => ACE_PREFIX.test(label))) return true;
  const unicode = [];
  for (const label of labels) {
    if (!ACE_PREFIX.test(label)) {
      unicode.push(label);
      continue;
    }
    const decoded = uLabelOfALabel(label);
    if (decoded === null) return false;
    unicode.push(decoded);
  }
  return bidiDomainOk(unicode);
}

const SEPARATORS = /[\u3002\uff0e\uff61]/g;
const IGNORABLE_CODE_POINT = /^\p{Default_Ignorable_Code_Point}$/u;

function mapDomain(text) {
  let mapped = '';
  for (const character of text.replace(SEPARATORS, '.')) {
    if (mapped.length > MAX_MAPPED_UNITS) return null;
    if (character !== '\u200c' && character !== '\u200d' && IGNORABLE_CODE_POINT.test(character)) continue;
    mapped += character.normalize('NFKC').toLowerCase();
  }
  return mapped.length > MAX_MAPPED_UNITS ? null : mapped.normalize('NFC');
}

function idnHostname(text) {
  const mapped = mapDomain(text);
  if (mapped === null) return false;
  const labels = mapped.split('.');
  const unicode = [];
  for (const label of labels) {
    const decoded = label === '' ? null : uLabelOfAny(label);
    if (decoded === null) return false;
    unicode.push(decoded);
  }
  if (!bidiDomainOk(unicode)) return false;
  let total = unicode.length - 1;
  for (const label of unicode) {
    const length = aceLength(label);
    if (length > 63) return false;
    total += length;
  }
  return total <= MAX_NAME_OCTETS;
}

module.exports = { idnHostname, hostnameLabelsOk, derivedProperty, inRanges };
