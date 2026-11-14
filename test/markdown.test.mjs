import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('../src/content/markdown.js');
const { parse } = globalThis.Renard.markdown;

const text = (s) => ({ type: 'text', text: s });

test('paragraphs join soft line breaks with a space', () => {
  assert.deepEqual(parse('one\ntwo\n\nthree'), [
    { type: 'paragraph', children: [text('one'), text(' two')] },
    { type: 'paragraph', children: [text('three')] },
  ]);
});

test('inline emphasis, code, and strikethrough', () => {
  const [p] = parse('a **bold** and *em* and `x*y` and ~~gone~~');
  assert.deepEqual(p.children, [
    text('a '),
    { type: 'strong', children: [text('bold')] },
    text(' and '),
    { type: 'em', children: [text('em')] },
    text(' and '),
    { type: 'code', text: 'x*y' },
    text(' and '),
    { type: 'del', children: [text('gone')] },
  ]);
});

test('underscores inside words are not emphasis', () => {
  const [p] = parse('use snake_case_names here');
  assert.deepEqual(p.children, [text('use snake_case_names here')]);
});

test('nested emphasis inside italics', () => {
  const [p] = parse('*a **b** c*');
  assert.deepEqual(p.children, [
    { type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] },
  ]);
});

test('links allow only http(s) and mailto', () => {
  const [p] = parse('[ok](https://example.com) [bad](javascript:alert(1))');
  assert.equal(p.children[0].type, 'link');
  assert.equal(p.children[0].href, 'https://example.com/');
  assert.ok(p.children.slice(1).every((n) => n.type === 'text'));
});

test('links with their own text show the real destination', () => {
  const [p] = parse('[your settings](https://evil.example/s?c=1) and [https://claude.ai/settings](https://evil.example/x)');
  assert.equal(p.children[0].dest, 'evil.example');
  assert.equal(p.children[2].dest, 'evil.example');
  assert.equal(p.children[2].children.length, 1, 'no link inside link text');
  assert.deepEqual(p.children[2].children[0], text('https://claude.ai/settings'));
  const [q] = parse('<https://example.com> [me@example.com](mailto:me@example.com) [mail](mailto:a@b.example?body=x)');
  assert.equal(q.children[0].dest, undefined, 'autolink names itself');
  assert.equal(q.children[2].dest, undefined, 'address as text');
  assert.equal(q.children[4].dest, 'a@b.example');
});

test('deep nesting is capped instead of overflowing the stack', () => {
  const blocks = parse(`${'>'.repeat(6000)} deep`);
  let d = 0;
  for (let n = blocks[0]; n && n.type === 'quote'; n = n.children[0]) d++;
  assert.ok(d <= 21, `depth ${d}`);
});

test('bare URLs become links without trailing punctuation', () => {
  const [p] = parse('See https://example.com/docs.');
  assert.deepEqual(p.children[1], { type: 'link', href: 'https://example.com/docs', children: [text('https://example.com/docs')] });
  assert.deepEqual(p.children[2], text('.'));
});

test('fenced code keeps content and language, even unterminated', () => {
  assert.deepEqual(parse('```js\nconst a = 1;\n  b();\n```'), [{ type: 'code', lang: 'js', text: 'const a = 1;\n  b();' }]);
  assert.deepEqual(parse('```\nstill streaming'), [{ type: 'code', lang: '', text: 'still streaming' }]);
});

test('headings strip closing hashes only after a space', () => {
  assert.deepEqual(parse('## Title ##'), [{ type: 'heading', level: 2, children: [text('Title')] }]);
  assert.deepEqual(parse('# C#'), [{ type: 'heading', level: 1, children: [text('C#')] }]);
});

test('nested and loose lists', () => {
  const [list] = parse('- one\n  - sub\n- two\n\n- three');
  assert.equal(list.type, 'ul');
  assert.equal(list.items.length, 3);
  assert.equal(list.items[0].children[1].type, 'ul');
  const [ol] = parse('3. a\n4. b');
  assert.equal(ol.type, 'ol');
  assert.equal(ol.start, 3);
});

test('a list can interrupt a paragraph', () => {
  const blocks = parse('Steps:\n1. first\n2. second');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['paragraph', 'ol'],
  );
});

test('tables with alignment', () => {
  const [t] = parse('| a | b |\n|:--|--:|\n| 1 | 2 |');
  assert.equal(t.type, 'table');
  assert.deepEqual(t.align, ['left', 'right']);
  assert.deepEqual(t.rows[0][1], [text('2')]);
});

test('blockquotes and rules', () => {
  const blocks = parse('> quoted\n\n---');
  assert.equal(blocks[0].type, 'quote');
  assert.equal(blocks[1].type, 'hr');
});
