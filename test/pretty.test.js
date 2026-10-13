// node --test test/*.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { prettyMarkdown, cellsOf, wrap, strip } = require('../lib/pretty');

const lines = (t, width) => prettyMarkdown(t, { width }).split('\n');

test('renders an aligned box table and drops the markdown marks', () => {
  const out = lines('| Name | Cost |\n|---|---:|\n| **alpha** | $1.50 |\n| `b` | $22.00 |', 80);
  assert.deepStrictEqual(out, [
    '┌───────┬────────┐',
    '│ Name  │   Cost │',
    '├───────┼────────┤',
    '│ alpha │  $1.50 │',
    '│ b     │ $22.00 │',
    '└───────┴────────┘',
  ]);
});

test('every row of a table has the same width, wrapped or not', () => {
  const md = '| # | Prompt | Cost |\n|---:|---|---:|\n| 1 | a very long prompt that must wrap onto several lines in a narrow terminal | $0.10 |\n| 2 | short | $12.00 |';
  const out = lines(md, 50);
  const widths = new Set(out.map((l) => Array.from(l).length));
  assert.strictEqual(widths.size, 1);
  assert.ok(out.length > 6);                       // wrapped
  assert.ok(out.some((l) => l.includes('$12.00'))); // numbers stay whole
});

test('a number column is never squeezed below its widest value', () => {
  const out = prettyMarkdown('| Prompt | Cost |\n|---|---:|\n| some text here that is rather long | ~$4.00 |', { width: 20 });
  assert.ok(out.includes('~$4.00'));
});

test('escaped pipes stay inside their cell', () => {
  assert.deepStrictEqual(cellsOf('| a \\| b | c |'), ['a | b', 'c']);
});

test('headings are underlined, bullets and inline marks tidied, other text untouched', () => {
  const out = lines('# Title\n\nSome **bold** and `code` and _italic_ text.\n- item', 80);
  assert.deepStrictEqual(out, ['Title', '═════', '', 'Some bold and code and italic text.', '• item']);
  assert.strictEqual(strip('snake_case_name stays'), 'snake_case_name stays');
});

test('wrap breaks long hyphenated words at a hyphen and ends overlong cells with …', () => {
  assert.deepStrictEqual(wrap('claude-sonnet-5-5', 14), ['claude-sonnet-', '5-5']);
  const w = wrap('one two three four five six seven eight nine ten eleven twelve', 8);
  assert.strictEqual(w.length, 4);
  assert.ok(w[3].endsWith('…'));
});

test('text without tables passes through', () => {
  assert.strictEqual(prettyMarkdown('plain line\nsecond | not a table'), 'plain line\nsecond | not a table');
});
