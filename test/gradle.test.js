import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripGradleComments } from '../dist/gradle.js';

test('Gradle comments preserve line endings and separate adjacent tokens', () => {
  const content = 'implementation/* hidden */("runtime")\r\n/* outer\n/* nested */\napi("test")\n*/';
  assert.equal(stripGradleComments(content), content.replace(/\/\* hidden \*\//, '            ')
    .replace(/\/\* outer[\s\S]*$/, (comment) => comment.replace(/[^\r\n]/g, ' ')));
});

test('Gradle strings preserve comment markers and escaped quotes', () => {
  const content = String.raw`val url = "https://example.com/*path*/"
val escaped = "quote: \" /* still a string */"
val single = 'quote: \' /* still a string */'
val raw = """/* raw string */"""
val multiline = '''/* Groovy string */'''`;
  assert.equal(stripGradleComments(content), content);
});

test('Gradle line comments cannot open block comments', () => {
  assert.equal(stripGradleComments('// /*\napi("runtime")'), '     \napi("runtime")');
});
