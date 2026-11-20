import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rubyRuntimeDependencies } from '../dist/ruby.js';

test('detects add_dependency and add_runtime_dependency calls', () => {
  assert.deepEqual(rubyRuntimeDependencies("spec.add_dependency 'rake'"), ['rake']);
  assert.deepEqual(rubyRuntimeDependencies('spec.add_runtime_dependency "rack"'), ['rack']);
});

test('detects calls using parentheses', () => {
  assert.deepEqual(rubyRuntimeDependencies("spec.add_dependency('rake')"), ['rake']);
});

test('ignores bare dependency names in gemspec declarations', () => {
  const gemspec = "rack = 'puma'\nspec.add_dependency rack\nspec.add_runtime_dependency(rack)";
  assert.deepEqual(rubyRuntimeDependencies(gemspec), []);
});

test('ignores commented-out declarations', () => {
  assert.deepEqual(rubyRuntimeDependencies('# spec.add_dependency "rake"'), []);
});

test('ignores unrelated method calls', () => {
  assert.deepEqual(rubyRuntimeDependencies('spec.add_development_dependency "rake"'), []);
});

['<<TEXT', '<<-TEXT', '<<~TEXT', "<<'TEXT'", '<<-"TEXT"', '<<~`TEXT`'].forEach((opener) => {
  const terminator = /^<<[-~]/.test(opener) ? '  TEXT' : 'TEXT';
  const heredoc = `spec.description = ${opener}\nspec.add_dependency 'evil-gem'\n${terminator}`;

  test(`ignores declarations inside ${opener} heredoc bodies`, () => {
    assert.deepEqual(rubyRuntimeDependencies(heredoc), []);
    assert.deepEqual(rubyRuntimeDependencies(`${heredoc}\nspec.add_dependency 'real-gem'`), ['real-gem']);
  });
});

test('ignores multiple heredocs in opening order', () => {
  const gemspec = `messages = [<<FIRST, <<~'SECOND']
spec.add_dependency 'first-gem'
FIRST
spec.add_dependency 'second-gem'
  SECOND
spec.add_dependency 'real-gem'
`;
  assert.deepEqual(rubyRuntimeDependencies(gemspec), ['real-gem']);
});

test('requires an exact unindented terminator for plain heredocs', () => {
  const gemspec = "message = <<TEXT\n  TEXT\nspec.add_dependency 'evil-gem'\nTEXT extra\nspec.add_dependency 'evil-gem'\nTEXT\n";
  assert.deepEqual(rubyRuntimeDependencies(gemspec), []);
  assert.deepEqual(rubyRuntimeDependencies(`${gemspec}spec.add_dependency 'real-gem'`), ['real-gem']);
});

test('preserves heredoc boundaries with CRLF and comment characters in quoted delimiters', () => {
  const gemspec = "message = <<~'TEXT#END' # comment\r\nspec.add_dependency 'evil-gem'\r\n  TEXT#END\r\n";
  assert.deepEqual(rubyRuntimeDependencies(gemspec), []);
  assert.deepEqual(rubyRuntimeDependencies(`${gemspec}spec.add_dependency 'real-gem'`), ['real-gem']);
});

test('ignores heredoc openers in strings and comments', () => {
  const gemspec = "message = '<<TEXT' # <<OTHER\nspec.add_dependency 'real-gem'";
  assert.deepEqual(rubyRuntimeDependencies(gemspec), ['real-gem']);
});
