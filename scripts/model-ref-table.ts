import fs from 'node:fs';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const TABLE_MARK = '"MODELREF-TABLE"';

class Reader {
  private position = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skip(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position] as string)) this.position += 1;
  }

  private starts(token: string): boolean {
    this.skip();
    return this.text.startsWith(token, this.position);
  }

  private take(token: string): void {
    if (!this.starts(token)) throw new Error(`expected ${token} at ${this.position}: ${this.text.slice(this.position, this.position + 40)}`);
    this.position += token.length;
  }

  private list(close: string): Json[] {
    const items: Json[] = [];
    if (this.starts(close)) {
      this.take(close);
      return items;
    }
    for (;;) {
      items.push(this.value());
      if (this.starts(',')) {
        this.take(',');
        continue;
      }
      this.take(close);
      return items;
    }
  }

  value(): Json {
    this.skip();
    const here = this.text[this.position];
    if (this.starts('<<')) {
      this.take('<<');
      return this.list('>>');
    }
    if (here === '{') {
      this.take('{');
      return this.list('}');
    }
    if (here === '[') {
      this.take('[');
      const record: { [key: string]: Json } = {};
      for (;;) {
        this.skip();
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.position))?.[0];
        if (name === undefined) throw new Error(`expected a field name at ${this.position}`);
        this.position += name.length;
        this.take('|->');
        record[name] = this.value();
        if (this.starts(',')) {
          this.take(',');
          continue;
        }
        this.take(']');
        return record;
      }
    }
    if (here === '"') {
      const end = this.text.indexOf('"', this.position + 1);
      const text = this.text.slice(this.position + 1, end);
      this.position = end + 1;
      return text;
    }
    const word = /^[A-Za-z0-9_]+/.exec(this.text.slice(this.position))?.[0];
    if (word === undefined) throw new Error(`unreadable value at ${this.position}: ${this.text.slice(this.position, this.position + 40)}`);
    this.position += word.length;
    if (word === 'TRUE') return true;
    if (word === 'FALSE') return false;
    if (/^\d+$/.test(word)) return Number(word);
    throw new Error(`unknown word ${word}`);
  }
}

const canonical = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key] as Json)]));
  return value;
};

const output = fs.readFileSync(0, 'utf8');
const mark = output.indexOf(TABLE_MARK);
if (mark === -1) throw new Error('the TLC output has no MODELREF-TABLE line; run a configuration with PrintTable = TRUE (ModelRef.cfg)');
const reader = new Reader(output.slice(mark + TABLE_MARK.length).replace(/^\s*,/, ''));
const table = reader.value();
process.stdout.write(`${JSON.stringify(canonical(table), null, 1)}\n`);
