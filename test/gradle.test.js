import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradleDependencies, stripGradleComments } from '../dist/gradle.js';

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

[
  ["'org.example:first:1.0'", "'org.example:second:1.0'"],
  ['("org.example:first:1.0")', '("org.example:second:1.0")'],
  ["group: 'org.example', name: 'first'", "group: 'org.example', name: 'second'"],
  ['(group = "org.example", name = "first")', '(group = "org.example", name = "second")'],
].forEach(([first, second]) => {
  test(`Gradle detects declarations after braces and semicolons: ${first}`, () => {
    const expected = first.includes('group') ? ['org.example:first', 'org.example:second'] :
      ['org.example:first:1.0', 'org.example:second:1.0'];
    assert.deepEqual(gradleDependencies(`dependencies { implementation ${first} }`), expected.slice(0, 1));
    assert.deepEqual(gradleDependencies(`dependencies { implementation ${first}; api ${second} }`), expected);
  });
});

test('Gradle statement boundaries exclude comments, strings, and test configurations', () => {
  const content = `dependencies {
    // implementation("org.example:comment:1.0"); api("org.example:comment:1.0")
    /* { implementation 'org.example:block:1.0'; api 'org.example:block:1.0' } */
    testImplementation("org.example:test:1.0"); testApi("org.example:test:1.0")
    val text = "{ implementation 'org.example:string:1.0'; api 'org.example:string:1.0' }"
    val single = '{ implementation("org.example:single:1.0") }'
    val raw = """{ implementation("org.example:raw:1.0")
      api("org.example:raw:1.0") }"""
    val groovy = '''{ implementation 'org.example:groovy:1.0'
      api 'org.example:groovy:1.0' }'''
    customimplementation("org.example:custom:1.0"); obj.api("org.example:member:1.0")
  }`;
  assert.deepEqual(gradleDependencies(content), []);
});
