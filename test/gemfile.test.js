import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProductionGem } from '../dist/gemfile.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

const cases = [
  ['ungrouped dependency', "gem 'rake'", true],
  ['double-quoted dependency', '  gem "rake", "~> 13.0"', true],
  ['inline development', "gem 'rake', group: :development", false],
  ['inline test', "gem 'rake', group: :test", false],
  ['inline production', "gem 'rake', group: :production", true],
  ['inline group array', "gem 'rake', groups: [:development, :test]", false],
  ['multiline group array', "gem 'rake', groups: [\n  :development,\n  :test\n]", false],
  ['production group array', "gem 'rake', groups: [:production, :default]", true],
  ['inline string group', "gem 'rake', group: 'test'", false],
  ['legacy hash group', "gem 'rake', :group => :test", false],
  ['literal backslash in option', "gem 'rake', require: 'path\\\\rake'", true],
  ['continued package name', "gem \\\n  'rake', '~> 13.0'", true],
  ['continued development option', "gem 'rake', \\\n  group: :development", false],
  ['continued test option with CRLF', "gem 'rake', \\\r\n  group: :test", false],
  ['multiple explicit continuations', "gem \\\n  'rake', \\\n  group: :development", false],
  ['multiline options', "gem 'rake',\n  group: :development", false],
  ['parenthesized declaration', 'gem("rake", group: :test)', false],
  ['development block', "group :development do\n  gem 'rake'\nend", false],
  ['test block', "group :test do\n  gem 'rake'\nend", false],
  ['combined block', "group :development, :test do\n  gem 'rake'\nend", false],
  ['production block', "group :production do\n  gem 'rake'\nend", true],
  ['single-line test block', "group :test do gem 'rake' end", false],
  ['single-line production block', "group :production do gem 'rake' end", true],
  ['production brace block', "group(:production) { gem 'rake' }", true],
  ['source brace block', "source('https://rubygems.org') { gem 'rake' }", true],
  ['development brace block', "group(:development) { gem 'rake' }", false],
  ['test brace block', "group(:test) { gem 'rake' }", false],
  ['combined brace block', "group(:development, :test) { gem 'rake' }", false],
  ['multiline brace block', "group(:production) {\n  gem 'other'\n  gem 'rake'\n}", true],
  ['semicolon brace declarations', "group(:production) { gem 'other'; gem 'rake' }", true],
  ['nested brace groups', "group(:test) { group(:production) { gem 'rake' } }", false],
  ['brace source in excluded group', "group(:test) { source('https://rubygems.org') { gem 'rake' } }", false],
  ['brace inside excluded do block', "group :test do\n  source('https://rubygems.org') { gem 'other' }\n  gem 'rake'\nend", false],
  ['do inside excluded brace block', "group(:test) { source 'https://rubygems.org' do\n  gem 'other'\nend\ngem 'rake' }", false],
  ['after excluded brace block', "group(:test) { gem 'other' }; gem 'rake'", true],
  ['inline exclusion in brace block', "group(:production) { gem 'rake', group: :test }", false],
  ['hash options in brace block', "group(:production) { gem 'rake', { group: :test } }", false],
  ['hash options before production declaration', "gem 'other', { group: :test }; gem 'rake'", true],
  ['brace characters in strings', "source('https://example.com/{gems}') { gem 'rake' }", true],
  ['similar group name', "group :development_tools do\n  gem 'rake'\nend", true],
  ['production inline in test block', "group :test do\n  gem 'rake', group: :production\nend", false],
  ['test inline in production block', "group :production do\n  gem 'rake', group: :test\nend", false],
  ['nested groups', "group :test do\n  group :production do\n    gem 'rake'\n  end\nend", false],
  ['nested source', "group :test do\n  source 'https://example.com' do\n    gem 'other'\n  end\n  gem 'rake'\nend", false],
  ['nested conditional', "group :test do\n  if RUBY_ENGINE == 'ruby'\n    gem 'other'\n  end\n  gem 'rake'\nend", false],
  ['after excluded block', "group :test do\n  gem 'other'\nend\ngem 'rake'", true],
  ['multiple declarations', "gem 'rake', group: :test\ngem 'rake', group: :production", true],
  ['unrelated group', "gem 'other', group: :test\ngem 'rake'", true],
  ['commented declaration', "# gem 'rake'", false],
  ['block-commented declaration with an active test declaration', "=begin\ngem 'rake'\n=end\ngroup :test do\n  gem 'rake'\nend", false],
  ['production declaration after a tagged block comment', "=begin disabled\r\n=endless\r\ngem(\r\n=end disabled\r\ngem 'rake'", true],
  ['block markers inside a multiline string', "description = 'first line\n=begin\nlast line'\ngem 'rake'", true],
  ['commented group', "gem 'rake' # group: :test", true],
  ['group name in string option', "gem 'rake', require: ':test'", true],
  ['exact package name', "gem 'rake-extra'", false],
  ['missing dependency', '', false],
];

[':production', ':default', ':development_tools', "'production'", '"production"'].forEach((group) => {
  [':test', ':development', ':development, :test'].forEach((excluded) => {
    [`${group}, ${excluded}`, `${excluded}, ${group}`].forEach((groups) => {
      cases.push(
        [`shared block ${groups}`, `group ${groups} do\n  gem 'rake'\nend`, true],
        [`shared brace block ${groups}`, `group(${groups}) { gem 'rake' }`, true],
        [`shared inline groups ${groups}`, `gem 'rake', groups: [${groups}]`, true],
        [`shared legacy groups ${groups}`, `gem 'rake', :groups => [${groups}]`, true],
      );
    });
  });
});

cases.forEach(([name, gemfile, expected]) => {
  test(name, async (t) => {
    t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
      data: path === '' ? [{ name: 'Gemfile' }] : { content: Buffer.from(gemfile).toString('base64') },
    }));
    assert.equal(await isProductionDependency('owner', 'repo', 'rake', 'ruby'), expected);
  });
});

test('gemspec runtime dependencies take precedence over Gemfile groups', async (t) => {
  t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
    data: path === '' ? [{ name: 'example.gemspec' }, { name: 'Gemfile' }] : {
      content: Buffer.from(path.endsWith('.gemspec')
        ? "spec.add_dependency 'rake'"
        : "gem 'rake', group: :test").toString('base64'),
    },
  }));
  assert.equal(await isProductionDependency('owner', 'repo', 'rake', 'ruby'), true);
});

test('ignores bare dependency names in Gemfile declarations', () => {
  const gemfile = "rack = 'puma'\ngem rack\ngem(rack)";
  assert.equal(isProductionGem(gemfile, 'rack'), false);
  assert.equal(isProductionGem(gemfile, 'puma'), false);
});

["'", '"'].forEach((quote) => {
  test(`preserves backslash-newline inside ${quote} strings`, () => {
    const name = "ra\\\n#ke";
    assert.equal(isProductionGem(`gem ${quote}${name}${quote}`, name), true);
    assert.equal(isProductionGem(`gem ${quote}${name}${quote}`, 'rake'), false);
  });
});

['<<TEXT', '<<-TEXT', '<<~TEXT', "<<'TEXT'", '<<-"TEXT"', '<<~`TEXT`'].forEach((opener) => {
  const terminator = /^<<[-~]/.test(opener) ? '  TEXT' : 'TEXT';
  const heredoc = `message = ${opener}\ngem 'rake'\nend\n} do\n# "unmatched quote\ngroup :test do\n${terminator}`;

  test(`ignores declarations and block tokens inside ${opener}`, () => {
    assert.equal(isProductionGem(`${heredoc}\ngroup :development do\n  gem 'rake'\nend`, 'rake'), false);
    assert.equal(isProductionGem(`group :test do\n${heredoc}\ngem 'rake'\nend`, 'rake'), false);
    assert.equal(isProductionGem(`${heredoc}\ngem 'rake'`, 'rake'), true);
    assert.equal(isProductionGem(`group :test do\n${heredoc}\nend\ngem 'rake'`, 'rake'), true);
  });
});

test('ignores multiple heredocs in opening order while preserving header declarations', () => {
  const gemfile = `messages = [<<FIRST, <<~'SECOND']; gem 'rake', group: :test
end
FIRST
gem 'rake'
  SECOND
`;
  assert.equal(isProductionGem(gemfile, 'rake'), false);
  assert.equal(isProductionGem(gemfile.replace('group: :test', 'group: :production'), 'rake'), true);
});

test('requires an exact unindented terminator for plain heredocs', () => {
  const gemfile = "message = <<TEXT\n  TEXT\ngem 'rake'\nTEXT extra\ngem 'rake'\nTEXT\n";
  assert.equal(isProductionGem(gemfile, 'rake'), false);
  assert.equal(isProductionGem(`${gemfile}gem 'rake'`, 'rake'), true);
});

test('preserves heredoc boundaries with CRLF and comment characters in quoted delimiters', () => {
  const gemfile = "message = <<~'TEXT#END' # comment\r\ngem 'rake'\r\n  TEXT#END\r\n";
  assert.equal(isProductionGem(gemfile, 'rake'), false);
  assert.equal(isProductionGem(`${gemfile}gem 'rake'`, 'rake'), true);
});

test('ignores heredoc openers in strings and comments', () => {
  const gemfile = "message = '<<TEXT' # <<OTHER\ngem 'rake'";
  assert.equal(isProductionGem(gemfile, 'rake'), true);
});

[
  ['non-interpolated', '%q{#{literal}\nclass FakeScope}'],
  ['interpolated', '%Q!#{"!"}\nmodule FakeScope!'],
].forEach(([name, literal]) => {
  test(`preserves group boundaries across a multiline ${name} percent string`, () => {
    const gemfile = `group :test do
  message = ${literal}
  gem 'rspec'
end
gem 'rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['slash delimiter', String.raw`/prefix\/suffix
class FakeScope
module FakeNamespace/ix`],
  ['paired percent delimiter', `%r{prefix{2}
class FakeScope
module FakeNamespace}ix`],
  ['unpaired percent delimiter', `%r!prefix
class FakeScope
module FakeNamespace!ix`],
  ['true ternary branch', `condition ? /prefix
class FakeScope/ : nil`],
  ['false ternary branch', `condition ? nil : /prefix
module FakeScope/`],
  ['unary negation', `!/prefix
class FakeScope/`],
  ['logical AND', `enabled && /prefix
class FakeScope/`],
  ['logical OR', `enabled || /prefix
class FakeScope/`],
  ['quoted interpolation', `/#{"a/b"}
end
suffix/`],
  ['percent string interpolation', `/#{{ value: %q{a/b} }.fetch(:value)}
end
suffix/`],
].forEach(([name, regexp]) => {
  test(`preserves group boundaries across a multiline regexp with a ${name}`, () => {
    const gemfile = `group :test do
  pattern = ${regexp}
  class TestHelper
  end
  gem 'rspec'
end
gem 'rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['slash', '?/'],
  ['escaped slash', String.raw`?\/`],
  ['opening brace', '?{'],
  ['slash in a ternary branch', 'condition ? ?/ : nil'],
].forEach(([name, expression]) => {
  test(`preserves group boundaries after a Ruby character literal (${name})`, () => {
    const gemfile = `group :test do
  class TestHelper
    character = ${expression}
  end
  gem 'rspec'
end
gem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['receiver.if', 'receiver&.unless', 'receiver::elsif'].forEach((call) => {
  test(`preserves a gem declaration after dividing the result of ${call}`, () => {
    const gemfile = `${call} / 2
gem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['parenthesized', 'puts(', ')'],
  ['unparenthesized', 'puts ', ''],
].forEach(([style, opening, closing]) => {
  test(`ignores scope keywords inside a multiline ${style} puts regexp argument`, () => {
    const gemfile = `group :test do
  ${opening}/prefix
class FakeScope
module FakeNamespace/i${closing}
  gem 'rspec'
end
gem 'rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('preserves a gem declaration between puts division and a regexp on its own line', () => {
  const gemfile = `puts = 4
puts /2
gem 'rack'
/prefix
suffix/`;
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('preserves a gem declaration after dividing the result of a puts call', () => {
  const gemfile = `puts / 2
gem 'rack', path: '/rack'`;
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['puts / 2', 'puts /2'].forEach((division) => {
  test(`preserves a gem declaration after ${division} divides a local variable`, () => {
    const gemfile = `puts = 4
${division}
gem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['def helper(ratio)', 'ratio'],
  ['def helper ratio', 'ratio'],
  ['def helper(puts)', 'puts'],
  ['def helper puts', 'puts'],
].forEach(([header, parameter]) => {
  test(`preserves a gem declaration after dividing a method parameter (${header})`, () => {
    const gemfile = `${header}
  ${parameter} /2
  gem 'rack', path: '/rack'
end`;
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('preserves a gem declaration between local division and a multiline regexp', () => {
  const gemfile = `value = 4
value /2
gem 'rack'
pattern = /
prefix
suffix/`;
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

[':test', ':development', ':development, :test'].forEach((group) => {
  ['class TestHelper\nend',
    'module TestHelpers\n  class TestHelper\n  end\nend',
    'result = class TestHelper\nend',
    'result = module TestHelpers\nend',
    'class <<self\nend',
    'class << self\nend',
    'result = class <<self\nend',
    'def test_helper\n  true\nend',
    'def test_helper = true',
    'def self.test_helper = true',
    'def test_helper(value = true) = value',
    'def test_helper = (true)',
    'def test_helper(value = true)\n  value\nend',
    'def test_helper() end',
    'def test_helper value = true\n  value\nend',
    'def test_helper=(value)\n  @value = value\nend',
    'def self.test_helper=(value)\n  @value = value\nend',
    'def test_helper\n  def nested_helper\n    true\n  end\nend',
    'def self.test_helper; true; end'].forEach((definition) => {
    const gemfile = `group ${group} do
${definition}
  gem 'rspec'
end
gem 'rack'`;

    test(`preserves ${group} scope across ${definition}`, async (t) => {
      t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
        data: path === '' ? [{ name: 'Gemfile' }] : { content: Buffer.from(gemfile).toString('base64') },
      }));
      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
      assert.equal(await isProductionDependency('owner', 'repo', 'rspec', 'ruby'), false);
      assert.equal(await isProductionDependency('owner', 'repo', 'rack', 'ruby'), true);
    });
  });
});

test('preserves group boundaries across a singleton class with a Ruby block comment', () => {
  const gemfile = `group :test do
  class <<self
=begin
end
gem 'ignored'
=end
  end
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});
