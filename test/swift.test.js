import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swiftDependencies } from '../dist/swift.js';

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
