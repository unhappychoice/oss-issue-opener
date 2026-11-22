import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packageIdentifiers, swiftDependencies } from '../dist/swift.js';

const measureParsing = (count) => {
  const names = Array.from({ length: count }, (_, index) => `package-${index}`);
  const content = `let package = Package(dependencies: [${names.map((name) =>
    `.package(url: "https://example.com/${name}.git", .upToNextMajor(from: "1.0.0"))`
  ).join(',')}])`;
  const slice = Array.prototype.slice;
  const includes = Array.prototype.includes;
  let copiedElements = 0;
  let argumentChecks = 0;
  Array.prototype.slice = function (...args) {
    const result = slice.apply(this, args);
    copiedElements += result.length;
    return result;
  };
  Array.prototype.includes = function (...args) {
    argumentChecks++;
    return includes.apply(this, args);
  };
  let dependencies;
  try {
    dependencies = swiftDependencies(content);
  } finally {
    Array.prototype.slice = slice;
    Array.prototype.includes = includes;
  }
  assert.deepEqual(dependencies, new Set(names));
  return { copiedElements, argumentChecks };
};

test('Swift parsing avoids token array copies and scales linearly with declarations', () => {
  const measurements = [128, 256, 512].map(measureParsing);
  measurements.forEach(({ copiedElements, argumentChecks }, index) => {
    assert.equal(copiedElements, 0);
    assert.ok(argumentChecks > 0);
    assert.ok(argumentChecks <= 20 * 128 * 2 ** index);
    if (index > 0) {
      assert.equal(argumentChecks, measurements[index - 1].argumentChecks * 2);
    }
  });
});

test('Swift package scanning reads a bounded number of tokens per nested call', () => {
  for (const depth of [128, 256, 512]) {
    const names = Array.from({ length: depth }, (_, index) => `package-${index}`);
    const openings = names.flatMap((name) => ['.', 'package', '(', 'id', ':', `"${name}"`, ',']);
    for (const closings of [[], Array(depth).fill(')')]) {
      let reads = 0;
      const tokens = new Proxy([...openings, ...closings], {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      });
      assert.deepEqual([...packageIdentifiers(tokens)], names);
      assert.ok(reads <= 4 * tokens.length, `${reads} token reads at depth ${depth}`);
    }
  }
});

test('Swift extracts direct arguments from outer and nested package calls', () => {
  const content = `
    .package(wrap(id: "ignored", .package(path: "../Inner/")), url: "https://example.com/Outer.git")
    .package(name: "Alias", id: "Registry.Library")
  `;
  assert.deepEqual([...swiftDependencies(content)], ['outer', 'inner', 'alias', 'registry.library']);
});

test('Swift finds a dependency after deeply nested string interpolation', () => {
  const depth = 20_000;
  const opening = String.raw`"\(`.repeat(depth);
  const closing = ')"'.repeat(depth);
  const content = `let label = ${opening}0${closing}
let package = Package(dependencies: [.package(url: "https://example.com/swift-log.git", from: "1.0.0")])`;
  assert.deepEqual(swiftDependencies(content), new Set(['swift-log']));
});

test('Swift recovers from unterminated strings inside interpolation', () => {
  const content = String.raw`
let label = "\(#"unfinished)"
let package = Package(dependencies: [.package(url: "https://example.com/swift-log.git")])
let unfinished = "\(#"unfinished
`;
  assert.deepEqual(swiftDependencies(content), new Set(['swift-log']));
});

test('Swift requires matching hash counts to close an extended regex', () => {
  const content = String.raw`
let pattern = ##/
  /# .package(id: "short")
  /### .package(id: "long")
  \/## .package(id: "escaped")
/##
let package = Package(dependencies: [.package(path: "../actual")])
`;
  assert.deepEqual(swiftDependencies(content), new Set(['actual']));
});

test('Swift skips extended regexes inside string interpolation', () => {
  const content = String.raw`
let label = "\(#/[)]" .package(id: "ghost")/#)"
let package = Package(dependencies: [.package(path: "../actual")])
`;
  assert.deepEqual(swiftDependencies(content), new Set(['actual']));
});

test('Swift recovers from an unterminated extended regex', () => {
  const content = 'let pattern = ##/unfinished/#\n.package(path: "../actual")';
  assert.deepEqual(swiftDependencies(content), new Set(['actual']));
});

test('Swift stops an unterminated single-line extended regex at a line break', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const content = [
      'let unfinished = #/unfinished\\',
      'let package = Package(dependencies: [.package(path: "../actual")])',
      'let pattern = #/.package(id: "ghost")/#',
    ].join(newline);
    assert.deepEqual(swiftDependencies(content), new Set(['actual']));
  }
});
