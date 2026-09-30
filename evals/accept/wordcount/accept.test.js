const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { countWords } = require('./count.js');

test('countWords', () => assert.deepEqual(countWords('The cat, the DOG. the end'), { the: 3, cat: 1, dog: 1, end: 1 }));
test('cli output order', () => {
  const out = execFileSync('node', ['cli.js'], { input: 'b a b c a b' }).toString().trim();
  assert.equal(out, 'b 3\na 2\nc 1');
});
