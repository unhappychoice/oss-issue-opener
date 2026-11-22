import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGradleDependencies, stripGradleComments } from '../dist/gradle.js';

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
    assert.deepEqual(parseGradleDependencies(`dependencies { implementation ${first} }`).coordinates, expected.slice(0, 1));
    assert.deepEqual(parseGradleDependencies(`dependencies { implementation ${first}; api ${second} }`).coordinates, expected);
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
  assert.deepEqual(parseGradleDependencies(content).coordinates, []);
});

test('Gradle keeps constraint scope across nested blocks, strings, and comments', () => {
  const content = `dependencies {
    api("org.example:before:1.0")
    constraints() /* { */ {
      implementation("org.example:before-nested:1.0") { because("}") }
      constraints { api("org.example:nested:1.0") }
      api(group = "org.example", name = "after-nested")
    }; implementation("org.example:after:1.0")
  }`;
  assert.deepEqual(parseGradleDependencies(content).coordinates, ['org.example:before:1.0', 'org.example:after:1.0']);
});

test('Gradle collects wrapped coordinates and aliases from the same script', () => {
  const content = `dependencies {
    api enforcedPlatform(group: 'org.example', name: 'bom')
    implementation(platform(libs.example.bom.get()))
    api("org.example:core:1.0")
    testImplementation(platform(libs.example.test))
    constraints { api(enforcedPlatform(libs.example.constraint)) }
    implementation(otherPlatform(libs.example.unsupported))
  }`;
  assert.deepEqual(parseGradleDependencies(content), {
    coordinates: ['org.example:bom', 'org.example:core:1.0'],
    aliases: ['example.bom'],
  });
});

test('Gradle keeps constraint scope across Groovy slashy strings', () => {
  const content = String.raw`dependencies {
    constraints {
      implementation('org.example:first:1.0') { because(/reason }/) }
      api('org.example:second:1.0') { because /escaped slash } \// }
      implementation('org.example:third:1.0')
    }
    def ratio = 8 / 2
    def pattern = /{ api('org.example:string:1.0') }/
    api('org.example:runtime:1.0')
  }`;
  assert.equal(stripGradleComments(content), content);
  assert.deepEqual(parseGradleDependencies(content).coordinates, ['org.example:runtime:1.0']);
});

test('Gradle distinguishes slashy strings, division, and comments across long whitespace runs', () => {
  const gap = ' \t'.repeat(50_000);
  const blankLines = '\r\n'.repeat(50_000);
  const inlineComment = '/* nested /* block */ comment */';
  const lineComment = '// api("org.example:comment:1.0")';
  const divisionComment = '/* division */';
  const pattern = String.raw`/{ api('org.example:string:1.0'); \/\/ }/`;
  const content = `dependencies {
    constraints {
      implementation('org.example:constraint:1.0') { because${gap}/reason }/ }
      def pattern = ${inlineComment}${gap}${pattern}
    }
    def ratio = 8${gap}/ 2 ${divisionComment}
    def scale = becauseFactor${gap}/ 2 ${divisionComment}
    def value =${gap}${lineComment}
      1
    ${blankLines}${gap}api('org.example:runtime:1.0')
    ${gap}implementation(libs.runtime.core)
  }`;
  const stripped = [inlineComment, lineComment, divisionComment].reduce(
    (code, comment) => code.replaceAll(comment, ' '.repeat(comment.length)),
    content
  );

  assert.equal(stripGradleComments(content), stripped);
  assert.deepEqual(parseGradleDependencies(content), {
    coordinates: ['org.example:runtime:1.0'],
    aliases: ['runtime.core'],
  });
});

test('Gradle keeps constraint scope across Groovy dollar slashy strings', () => {
  const content = `dependencies {
    constraints {
      implementation('org.example:first:1.0') { because($/reason }/$) }
      api('org.example:second:1.0') { because $/escaped closing delimiter $/$$ }
        // text inside the reason
        /* also inside the reason */ /$ }
      api('org.example:third:1.0')
    }
    def text = $/{ api('org.example:string:1.0') }/$
    api('org.example:runtime:1.0')
  }`;
  assert.deepEqual(parseGradleDependencies(content).coordinates, ['org.example:runtime:1.0']);
  assert.equal(stripGradleComments(content), content);
});

test('Gradle keeps constraint scope across slashy strings at the start of Groovy lists', () => {
  const content = `dependencies {
    constraints {
      def reasons = [/reason }/, /another reason/]
      api('org.example:constraint:1.0')
    }
    api('org.example:runtime:1.0')
  }`;
  assert.deepEqual(parseGradleDependencies(content).coordinates, ['org.example:runtime:1.0']);
});

['implementation', 'api'].forEach((configuration) => {
  ['platform', 'enforcedPlatform'].forEach((wrapper) => {
    [
      [`(${wrapper}("org.example:bom:1.0"))`, 'org.example:bom:1.0'],
      [` ${wrapper}('org.example:bom:1.0')`, 'org.example:bom:1.0'],
      [`(\n${wrapper} /* BOM */ (\n"org.example:bom:1.0"\n))`, 'org.example:bom:1.0'],
      [` ${wrapper}(group: 'org.example', name: 'bom', version: '1.0')`, 'org.example:bom'],
      [`(${wrapper}(group = "org.example", name = "bom", version = "1.0"))`, 'org.example:bom'],
    ].forEach(([call, coordinate]) => {
      test(`Gradle detects wrapped production dependencies: ${configuration}${call}`, () => {
        assert.deepEqual(parseGradleDependencies(`dependencies { ${configuration}${call} }`).coordinates, [coordinate]);
      });
    });

    test(`Gradle excludes ${wrapper} outside production declarations`, () => {
      const content = `dependencies {
        testImplementation(${wrapper}("org.example:test:1.0"))
        testApi ${wrapper}('org.example:test:1.0')
        ${wrapper}("org.example:standalone:1.0")
        customimplementation(${wrapper}("org.example:custom:1.0"))
        obj.api(${wrapper}("org.example:member:1.0"))
        // ${configuration}(${wrapper}("org.example:comment:1.0"))
        /* { ${configuration} ${wrapper}('org.example:block:1.0') } */
        val text = "{ ${configuration} ${wrapper}('org.example:string:1.0') }"
        val raw = """{ ${configuration}(${wrapper}("org.example:raw:1.0")) }"""
        val groovy = '''{ ${configuration} ${wrapper}('org.example:groovy:1.0') }'''
        ${configuration}(otherPlatform("org.example:other:1.0"))
      }`;
      assert.deepEqual(parseGradleDependencies(content).coordinates, []);
    });
  });
});
