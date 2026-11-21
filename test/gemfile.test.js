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

[
  String.raw`%w!words \! #{
class FakeClass
module FakeModule
!`,
  '%W{words #{%w[more words]}\nclass FakeClass\nmodule FakeModule\n}',
].forEach((literal) => {
  test(`preserves group boundaries across a multiline ${literal.slice(0, 2)} literal`, () => {
    const gemfile = `group :test do
  words = ${literal}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['/x', '/rack', '/'].forEach((path) => {
  ['warn', 'puts', 'helper'].forEach((name) => {
    test(`detects a gem with path ${path} after compact division of the ${name} block parameter`, () => {
      const gemfile = `group :test do
  [4].each do |${name}|
    ${name} /2
  end
  gem 'rspec'
end
gem 'rack', path: '${path}'`;

      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
    });
  });
});

test('preserves the group boundary when a comment follows compact block-parameter division', () => {
  const gemfile = `group :test do
  [4].each do |warn|
    warn /2
  end
  gem 'rspec'
end
# /
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('ignores class and module text in a multiline regexp inside an excluded group', () => {
  const gemfile = String.raw`group :test do
  pattern = /prefix\/
class FakeClass
module FakeModule
/x
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['puts', 'helper'].forEach((name) => {
  test(`preserves group exclusions after a multiline regexp passed to ${name}`, () => {
    const gemfile = `group :test do
  warn = 4
  ${name} /prefix
class FakeClass
/x
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['an unparenthesized slash regexp', ' /2\nclass FakeClass\n/x'],
  ['an unparenthesized percent regexp', ' %r!prefix\nclass FakeClass\nsuffix!x'],
  ['an unparenthesized bare percent string', ' %!prefix\nclass FakeClass\nsuffix!'],
  ['a parenthesized slash regexp', '(/prefix\nclass FakeClass\n/x)'],
  ['a parenthesized percent regexp', '(%r{prefix\nclass FakeClass\n}x)'],
  ['division with space after the slash', ' / 2'],
  ['division with no space before the slash', '/2'],
].forEach(([description, suffix]) => {
  test(`preserves group exclusions when warn is followed by ${description}`, () => {
    const gemfile = `group :test do
  warn${suffix}
  gem 'rspec'
end
gem 'rack'
pattern = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['warn', 'puts', 'helper'].forEach((name) => {
  test(`detects a production gem after compact division of a local variable named ${name}`, () => {
    const gemfile = `group :test do
  ${name} = 4
  ${name} /2
  gem 'rspec'
end
gem 'rack', path: '/x'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['a class', 'class Helper\n  warn = 4\nend'],
  ['a module', 'module Helpers\n  warn = 4\nend'],
  ['a singleton class', 'class <<self\n  warn = 4\nend'],
  ['a method', 'def helper\n  warn = 4\nend'],
  ['a block assignment', '[4].each do\n  warn = 4\nend'],
  ['a block parameter', '[4].each do |warn|\n  warn /2\nend'],
].forEach(([description, definition]) => {
  test(`recognizes a warn regexp after ${description} with a local warn`, () => {
    const gemfile = `group :test do
${definition}
  warn /prefix
class FakeClass
/x
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('isolates namespace locals and restores the enclosing warn variable', () => {
  const gemfile = `group :test do
  if true
    warn = 4
  end
  module Helpers
    class Helper
      warn /prefix
end
/x
    end
  end
  [4].each do
    warn /2
  end
  warn /2
  gem 'rspec'
end
gem 'rack', path: '/x'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['if', 'unless'].forEach((keyword) => {
  test(`ignores class text in a multiline regexp used as an ${keyword} condition`, () => {
    const gemfile = `group :test do
  ${keyword} /prefix
class FakeClass
/ =~ ENV['FEATURE']
    gem 'conditional'
  end
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'conditional'), false);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['slash', '/prefix\nclass FakeClass\n/x'],
  ['percent', '%r{prefix\nclass FakeClass\n}x'],
].forEach(([delimiter, pattern]) => {
  test(`ignores class text in a multiline ${delimiter} regexp in a when clause`, () => {
    const gemfile = `group :test do
  case ENV['FEATURE']
  when ${pattern}
    gem 'conditional'
  end
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'conditional'), false);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['&&', '||', 'and', 'or'].forEach((operator) => {
  test(`ignores class text in a multiline regexp after ${operator}`, () => {
    const gemfile = `group :test do
  pattern = ENV['FEATURE'] ${operator} /prefix
class FakeClass
/x
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['if', 'when'].forEach((method) => {
  test(`recognizes division after a method named ${method}`, () => {
    const gemfile = `group :test do
  result = settings.${method} / 2
  gem 'rspec'
end
gem 'rack'
pattern = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['a negated slash regexp', String.raw`!/prefix\/
class FakeClass
/x`],
  ['a non-interpolated percent string', `%q{prefix{
class FakeClass
}suffix}`],
  ['an interpolated percent string', `%Q{prefix#{/a.b/i}
module FakeModule
suffix}`],
  ['a percent regexp with an escaped delimiter', String.raw`%r!prefix\!
class FakeClass
!x`],
  ['a percent regexp with nested paired delimiters', `%r{prefix{
class FakeClass
}suffix}x`],
].forEach(([description, expression]) => {
  test(`ignores class text in ${description}`, () => {
    const gemfile = `group :test do
  pattern = ${expression}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  ['a percent string and division', '/prefix#{%q!}!; 4 / 2}suffix/'],
  ['a bare percent string with an escaped delimiter', '%!prefix\\!\nclass FakeClass\nsuffix!'],
  ['an interpolated bare percent string with paired delimiters', '%{prefix{#{/a.b/i}\nmodule FakeModule\n}suffix}'],
  ['a bare percent string in regexp interpolation', '/prefix#{%!}!; 4 / 2}\nclass FakeClass\n/'],
  ['a non-interpolated paired percent string', '/prefix#{%q{#{}}; 4 / 2}suffix/'],
  ['an interpolated paired percent string containing a regexp', '/prefix#{%Q{#{/a.b/i}}; 4 / 2}suffix/'],
  ['a regexp in a ternary branch', 'true ? /prefix#{%q!}!; 4 / 2}suffix/ : /fallback/'],
  ['a multiline regexp in the false ternary branch', 'false ? nil : /prefix\nclass FakeClass\n/'],
].forEach(([description, expression]) => {
  test(`preserves group exclusions after ${description}`, () => {
    const gemfile = `group :test do
  pattern = ${expression}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});
