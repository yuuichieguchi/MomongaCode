'use strict'

function __ataSafeRegex () {
  const nativeExec = RegExp.prototype.exec
  const WS = [[9, 13], [32, 32], [160, 160], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]]
  const isLineTerminator = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029
  const DIGIT = [[48, 57]]
  const WORD = [[48, 57], [65, 90], [97, 122], [95, 95]]

  function parse (src) {
    let i = 0
    const chars = Array.from(src)
    const len = chars.length
    const peek = () => chars[i]
    const eof = () => i >= len

    function parseAlt () {
      const opts = [parseConcat()]
      while (!eof() && peek() === '|') { i++; opts.push(parseConcat()) }
      return opts.length === 1 ? opts[0] : { t: 'alt', opts }
    }

    function parseConcat () {
      const parts = []
      while (!eof() && peek() !== '|' && peek() !== ')') parts.push(parseRepeat())
      if (parts.length === 0) return { t: 'empty' }
      return parts.length === 1 ? parts[0] : { t: 'concat', parts }
    }

    function parseRepeat () {
      let node = parseAtom()
      while (!eof()) {
        const ch = peek()
        if (ch === '*') { i++; node = { t: 'star', child: node } }
        else if (ch === '+') { i++; node = { t: 'plus', child: node } }
        else if (ch === '?') { i++; node = { t: 'quest', child: node } }
        else if (ch === '{') {
          const saved = i
          const q = tryQuantifier()
          if (!q) { i = saved; break }
          node = { t: 'repeat', child: node, min: q.min, max: q.max }
        } else break
        if (!eof() && peek() === '?') i++
      }
      return node
    }

    function tryQuantifier () {
      i++
      let min = ''
      while (!eof() && /[0-9]/.test(peek())) { min += peek(); i++ }
      if (min === '') return null
      let max
      if (peek() === '}') { i++; return { min: +min, max: +min } }
      if (peek() === ',') {
        i++
        let m = ''
        while (!eof() && /[0-9]/.test(peek())) { m += peek(); i++ }
        if (peek() !== '}') return null
        i++
        max = m === '' ? Infinity : +m
        return { min: +min, max }
      }
      return null
    }

    function parseAtom () {
      const ch = peek()
      if (ch === '(') {
        i++
        if (chars[i] === '?') {
          if (chars[i + 1] === ':') { i += 2 }
          else throw new Error('unsupported group (lookaround/named) in pattern')
        }
        const child = parseAlt()
        if (peek() !== ')') throw new Error('unbalanced ( in pattern')
        i++
        return { t: 'group', child }
      }
      if (ch === '[') return parseClass()
      if (ch === '.') { i++; return { t: 'any' } }
      if (ch === '^') { i++; return { t: 'bol' } }
      if (ch === '$') { i++; return { t: 'eol' } }
      if (ch === '\\') return parseEscape(false)
      if (ch === ')' || ch === '|') return { t: 'empty' }
      i++
      return { t: 'char', c: ch.codePointAt(0) }
    }

    function parseClass () {
      i++
      let neg = false
      if (peek() === '^') { neg = true; i++ }
      const ranges = []
      const props = []
      while (!eof() && peek() !== ']') {
        let lo
        if (peek() === '\\') {
          const esc = parseEscape(true)
          if (esc.t === 'classpart') { for (const r of esc.ranges) ranges.push(r); for (const q of esc.props || []) props.push(q); continue }
          lo = esc.c
        } else { lo = peek().codePointAt(0); i++ }
        if (peek() === '-' && chars[i + 1] !== ']' && i + 1 < len) {
          i++
          let hi
          if (peek() === '\\') { const e = parseEscape(true); hi = e.c } else { hi = peek().codePointAt(0); i++ }
          ranges.push([lo, hi])
        } else {
          ranges.push([lo, lo])
        }
      }
      if (peek() !== ']') throw new Error('unbalanced [ in pattern')
      i++
      return { t: 'class', neg, ranges, props }
    }

    function propertyEscape (ch) {
      if (chars[i] !== '{') throw new Error('\\' + ch + ' needs a {property} in pattern')
      let end = i
      while (end < len && chars[end] !== '}') end++
      if (end >= len) throw new Error('unterminated \\' + ch + '{ in pattern')
      const name = chars.slice(i, end + 1).join('')
      i = end + 1
      return new RegExp('^\\' + ch + name + '$', 'u')
    }

    function parseEscape (inClass) {
      i++
      if (eof()) throw new Error('trailing backslash in pattern')
      const ch = peek(); i++
      switch (ch) {
        case 'd': return inClass ? { t: 'classpart', ranges: DIGIT } : { t: 'class', neg: false, ranges: DIGIT }
        case 'w': return inClass ? { t: 'classpart', ranges: WORD } : { t: 'class', neg: false, ranges: WORD }
        case 's': return inClass ? { t: 'classpart', ranges: WS } : { t: 'class', neg: false, ranges: WS }
        case 'D': if (inClass) throw new Error('\\D inside a class is not supported'); return { t: 'class', neg: true, ranges: DIGIT }
        case 'W': if (inClass) throw new Error('\\W inside a class is not supported'); return { t: 'class', neg: true, ranges: WORD }
        case 'S': if (inClass) throw new Error('\\S inside a class is not supported'); return { t: 'class', neg: true, ranges: WS }
        case 'n': return { t: 'char', c: 10 }
        case 'r': return { t: 'char', c: 13 }
        case 't': return { t: 'char', c: 9 }
        case 'f': return { t: 'char', c: 12 }
        case 'v': return { t: 'char', c: 11 }
        case '0': if (/[0-9]/.test(chars[i] || '')) throw new Error('octal escapes are not supported in pattern'); return { t: 'char', c: 0 }
        case 'x': { const h = chars.slice(i, i + 2).join(''); if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new Error('malformed \\x escape in pattern'); i += 2; return { t: 'char', c: parseInt(h, 16) } }
        case 'u': { const h = chars.slice(i, i + 4).join(''); if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new Error('malformed \\u escape in pattern'); i += 4; const unit = parseInt(h, 16)
          if (unit >= 0xd800 && unit <= 0xdbff && chars[i] === '\\' && chars[i + 1] === 'u') {
            const low = parseInt(chars.slice(i + 2, i + 6).join(''), 16)
            if (/^[0-9a-fA-F]{4}$/.test(chars.slice(i + 2, i + 6).join('')) && low >= 0xdc00 && low <= 0xdfff) { i += 6; return { t: 'char', c: (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000 } }
          }
          return { t: 'char', c: unit } }
        case 'b': if (inClass) return { t: 'char', c: 8 }; throw new Error('\\b word boundary is not supported')
        case 'p': case 'P': { const prop = propertyEscape(ch); return inClass ? { t: 'classpart', ranges: [], props: [prop] } : { t: 'class', neg: false, ranges: [], props: [prop] } }
        case 'c': {
          const letter = chars[i]
          if (letter === undefined || !/^[A-Za-z]$/.test(letter)) throw new Error('\\c needs a letter in pattern')
          i++
          return { t: 'char', c: letter.charCodeAt(0) % 32 }
        }
        case 'B': case 'k': throw new Error('\\' + ch + ' is not supported in pattern')
        default:
          if (/[1-9]/.test(ch)) throw new Error('backreferences are not supported in pattern')
          return { t: 'char', c: ch.codePointAt(0) }
      }
    }

    const ast = parseAlt()
    if (!eof()) throw new Error('unexpected "' + peek() + '" in pattern')
    return ast
  }

  const MAX_PROG = 1 << 16

  const BUDGET = 'pattern expands past the instruction budget'
  function compileProg (ast) {
    const prog = []
    const emit = (op, extra) => {
      const idx = prog.length
      if (idx >= MAX_PROG) throw new Error(BUDGET)
      prog.push(Object.assign({ op }, extra))
      return idx
    }

    function rec (n) {
      switch (n.t) {
        case 'empty': break
        case 'char': emit('char', { c: n.c }); break
        case 'any': emit('any'); break
        case 'class': emit('class', { neg: n.neg, ranges: n.ranges, props: n.props || [] }); break
        case 'bol': emit('bol'); break
        case 'eol': emit('eol'); break
        case 'group': rec(n.child); break
        case 'concat': for (const p of n.parts) rec(p); break
        case 'alt': {
          const jmps = []
          for (let k = 0; k < n.opts.length; k++) {
            if (k < n.opts.length - 1) {
              const sp = emit('split', { x: 0, y: 0 })
              prog[sp].x = prog.length
              rec(n.opts[k])
              jmps.push(emit('jmp', { x: 0 }))
              prog[sp].y = prog.length
            } else {
              rec(n.opts[k])
            }
          }
          for (const j of jmps) prog[j].x = prog.length
          break
        }
        case 'star': {
          const sp = emit('split', { x: 0, y: 0 })
          prog[sp].x = prog.length
          rec(n.child)
          emit('jmp', { x: sp })
          prog[sp].y = prog.length
          break
        }
        case 'plus': {
          const start = prog.length
          rec(n.child)
          const sp = emit('split', { x: start, y: 0 })
          prog[sp].y = prog.length
          break
        }
        case 'quest': {
          const sp = emit('split', { x: 0, y: 0 })
          prog[sp].x = prog.length
          rec(n.child)
          prog[sp].y = prog.length
          break
        }
        case 'repeat': {
          for (let k = 0; k < n.min; k++) rec(n.child)
          if (n.max === Infinity) {
            if (n.min === 0) rec({ t: 'star', child: n.child })
            else rec({ t: 'star', child: n.child })
          } else {
            for (let k = 0; k < n.max - n.min; k++) rec({ t: 'quest', child: n.child })
          }
          break
        }
      }
    }

    rec(ast)
    emit('match')
    return prog
  }

  const OP_CHAR = 0
  const OP_ANY = 1
  const OP_CLASS = 2
  const OP_SPLIT = 3
  const OP_JMP = 4
  const OP_BOL = 5
  const OP_EOL = 6
  const OP_MATCH = 7

  function classMatcher (instr) {
    const bits = new Uint8Array(128)
    const r = instr.ranges
    for (let k = 0; k < r.length; k++) {
      const hi = Math.min(r[k][1], 127)
      for (let c = r[k][0]; c <= hi; c++) bits[c] = 1
    }
    const props = instr.props
    for (let k = 0; k < props.length; k++) {
      for (let c = 0; c < 128; c++) if (nativeExec.call(props[k], String.fromCharCode(c)) !== null) bits[c] = 1
    }
    return { bits, ranges: r, props, neg: instr.neg }
  }

  function matchClass (cls, c) {
    let inside
    if (c < 128) {
      inside = cls.bits[c] === 1
    } else {
      inside = false
      const r = cls.ranges
      for (let k = 0; k < r.length; k++) { if (c >= r[k][0] && c <= r[k][1]) { inside = true; break } }
      if (!inside && cls.props.length > 0) {
        const text = String.fromCodePoint(c)
        for (let k = 0; k < cls.props.length; k++) { if (nativeExec.call(cls.props[k], text) !== null) { inside = true; break } }
      }
    }
    return cls.neg ? !inside : inside
  }

  function makeRunner (prog) {
    const n = prog.length
    const ops = new Uint8Array(n)
    const xs = new Int32Array(n)
    const ys = new Int32Array(n)
    const cs = new Int32Array(n)
    const classes = new Array(n)
    for (let i = 0; i < n; i++) {
      const I = prog[i]
      switch (I.op) {
        case 'char': ops[i] = OP_CHAR; cs[i] = I.c; break
        case 'any': ops[i] = OP_ANY; break
        case 'class': ops[i] = OP_CLASS; classes[i] = classMatcher(I); break
        case 'split': ops[i] = OP_SPLIT; xs[i] = I.x; ys[i] = I.y; break
        case 'jmp': ops[i] = OP_JMP; xs[i] = I.x; break
        case 'bol': ops[i] = OP_BOL; break
        case 'eol': ops[i] = OP_EOL; break
        case 'match': ops[i] = OP_MATCH; break
      }
    }

    const lastGen = new Int32Array(n).fill(-1)
    let gen = 0
    const stack = new Int32Array(2 * n + 2)
    let clist = new Int32Array(n)
    let nlist = new Int32Array(n)
    let clen = 0
    let nlen = 0

    function addThread (list, len0, pc, pos, len) {
      if (ops[pc] <= OP_CLASS || ops[pc] === OP_MATCH) {
        if (lastGen[pc] === gen) return len0
        lastGen[pc] = gen
        list[len0] = pc
        return len0 + 1
      }
      let sp = 0
      stack[sp++] = pc
      let count = len0
      while (sp > 0) {
        const p = stack[--sp]
        if (lastGen[p] === gen) continue
        lastGen[p] = gen
        switch (ops[p]) {
          case OP_JMP: stack[sp++] = xs[p]; break
          case OP_SPLIT: stack[sp++] = ys[p]; stack[sp++] = xs[p]; break
          case OP_BOL: if (pos === 0) stack[sp++] = p + 1; break
          case OP_EOL: if (pos === len) stack[sp++] = p + 1; break
          default: list[count++] = p
        }
      }
      return count
    }

    gen++
    const anchored = addThread(nlist, 0, 0, 1, 1) === 0

    function testNFA (s) {
      const len = s.length
      gen++
      clen = addThread(clist, 0, 0, 0, len)
      let pos = 0
      while (pos <= len) {
        const c = pos < len ? s.codePointAt(pos) : -1
        const next = c > 0xffff ? pos + 2 : pos + 1
        gen++
        nlen = 0
        for (let k = 0; k < clen; k++) {
          const pc = clist[k]
          switch (ops[pc]) {
            case OP_MATCH: return true
            case OP_CHAR: if (c === cs[pc]) nlen = addThread(nlist, nlen, pc + 1, next, len); break
            case OP_ANY: if (c !== -1 && !isLineTerminator(c)) nlen = addThread(nlist, nlen, pc + 1, next, len); break
            case OP_CLASS: if (c !== -1 && matchClass(classes[pc], c)) nlen = addThread(nlist, nlen, pc + 1, next, len); break
          }
        }
        if (pos < len) {
          if (!anchored) nlen = addThread(nlist, nlen, 0, next, len)
          else if (nlen === 0) return false
        }
        const tmp = clist; clist = nlist; nlist = tmp
        clen = nlen
        pos = next
      }
      return false
    }

    const MAX_STATES = 256
    const states = []
    const stateIds = new Map()
    let overflow = false
    let cap = 0
    let trans = new Int16Array(0)
    let transEnd = new Int16Array(0)
    let flags = new Uint8Array(0)
    function grow () {
      const next = cap === 0 ? 2 : cap * 2
      const t = new Int16Array(next * 128).fill(-2); t.set(trans); trans = t
      const te = new Int16Array(next * 128).fill(-2); te.set(transEnd); transEnd = te
      const f = new Uint8Array(next); f.set(flags); flags = f
      cap = next
    }

    function closure (list, count, pc, atStart, atEnd) {
      let sp = 0
      stack[sp++] = pc
      while (sp > 0) {
        const p = stack[--sp]
        if (lastGen[p] === gen) continue
        lastGen[p] = gen
        switch (ops[p]) {
          case OP_JMP: stack[sp++] = xs[p]; break
          case OP_SPLIT: stack[sp++] = ys[p]; stack[sp++] = xs[p]; break
          case OP_BOL: if (atStart) stack[sp++] = p + 1; break
          case OP_EOL: if (atEnd) stack[sp++] = p + 1; break
          default: list[count++] = p
        }
      }
      return count
    }

    function internState (list, count) {
      const pcs = Array.from(list.subarray(0, count)).sort((a, b) => a - b)
      const key = pcs.join(',')
      let id = stateIds.get(key)
      if (id !== undefined) return id
      if (states.length >= MAX_STATES) { overflow = true; return -1 }
      id = states.length
      let isMatch = false
      for (let k = 0; k < pcs.length; k++) if (ops[pcs[k]] === OP_MATCH) { isMatch = true; break }
      states.push({ pcs: Int32Array.from(pcs) })
      if (id >= cap) grow()
      flags[id] = (isMatch ? 1 : 0) | (anchored && pcs.length === 0 ? 2 : 0)
      stateIds.set(key, id)
      return id
    }

    function step (state, c, atEnd) {
      gen++
      let count = 0
      const pcs = state.pcs
      for (let k = 0; k < pcs.length; k++) {
        const pc = pcs[k]
        switch (ops[pc]) {
          case OP_CHAR: if (c === cs[pc]) count = closure(nlist, count, pc + 1, false, atEnd); break
          case OP_ANY: if (!isLineTerminator(c)) count = closure(nlist, count, pc + 1, false, atEnd); break
          case OP_CLASS: if (matchClass(classes[pc], c)) count = closure(nlist, count, pc + 1, false, atEnd); break
        }
      }
      if (!anchored) count = closure(nlist, count, 0, false, atEnd)
      return internState(nlist, count)
    }

    let startEmpty = -2
    let startNonEmpty = -2

    function startState (atEnd) {
      gen++
      const count = closure(nlist, 0, 0, true, atEnd)
      return internState(nlist, count)
    }

    function testDFA (s) {
      const len = s.length
      let id
      if (len === 0) {
        if (startEmpty === -2) startEmpty = startState(true)
        id = startEmpty
      } else {
        if (startNonEmpty === -2) startNonEmpty = startState(false)
        id = startNonEmpty
      }
      if (id < 0) return testNFA(s)
      if (len === 0) return (flags[id] & 1) === 1
      if ((flags[id] & 1) === 1) return true
      const lastUnit = s.charCodeAt(len - 1)
      const last = len >= 2 && lastUnit >= 0xdc00 && lastUnit <= 0xdfff && s.charCodeAt(len - 2) >= 0xd800 && s.charCodeAt(len - 2) <= 0xdbff ? len - 2 : len - 1
      let T = trans
      let F = flags
      for (let pos = 0; pos < last;) {
        const c = s.codePointAt(pos)
        pos += c > 0xffff ? 2 : 1
        let nid = c < 128 ? T[(id << 7) | c] : -2
        if (nid === -2) {
          nid = step(states[id], c, false)
          T = trans; F = flags
          if (c < 128 && (nid >= 0 || overflow)) T[(id << 7) | c] = nid
        }
        if (nid < 0) return testNFA(s)
        id = nid
        const f = F[id]
        if (f !== 0) {
          if ((f & 2) === 2) return false
          return true
        }
      }
      const c = s.codePointAt(last)
      let nid
      if (c < 128) {
        nid = transEnd[(id << 7) | c]
        if (nid === -2) { nid = step(states[id], c, true); if (nid >= 0 || overflow) transEnd[(id << 7) | c] = nid }
      } else {
        nid = step(states[id], c, true)
      }
      if (nid < 0) return testNFA(s)
      return (flags[nid] & 1) === 1
    }

    return function test (s) {
      return overflow ? testNFA(s) : testDFA(s)
    }
  }

  function compileSafe (pattern) {
    const prog = compileProg(parse(pattern))
    const runner = makeRunner(prog)
    return { test: runner, source: pattern, __ataSafe: true }
  }

  function patternIsSafe (src) {
    try { compileSafe(src); return true } catch { return false }
  }

  return { compileSafe, patternIsSafe, parse }
}

module.exports = __ataSafeRegex()
module.exports.engineSource = () => __ataSafeRegex.toString()
