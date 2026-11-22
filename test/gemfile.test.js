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
  ['def test_helper\n  true\nend',
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

const namespaceDefinitions = [
  'class TestHelper; end',
  'module TestHelpers\n  class TestHelper < Object\n  end\nend',
  'result = class TestHelper; end',
  'result = module TestHelpers; end',
  'class <<self; end',
  'class << self; end',
  'result = class <<self; end',
  'class <<self\n=begin\nend\ngem "ignored"\n=end\nend',
];

[':test', ':development', ':development, :test'].forEach((group) => {
  namespaceDefinitions.forEach((definition) => {
    test(`preserves ${group} scope across ${definition}`, () => {
      const gemfile = `group ${group} do
${definition}
  gem 'rspec'
end
gem 'rack'`;

      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
      assert.equal(isProductionGem(gemfile, 'ignored'), false);
    });
  });
});

test('recognizes a production gem after dividing a block parameter named warn', () => {
  const gemfile = `group :test do
  class TestHelper
    [4].each do |warn|
      warn /2
    end
  end
  gem 'rspec'
end
gem 'rack'
another_ratio = 8 / 2`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

[
  ['->(warn) do', 'end', 'warn /2'],
  ['callback = ->(value, warn: 4) {', '}', 'warn /2'],
  ['-> do', 'end', 'warn /prefix\nclass RegexpText\nend\nsuffix/'],
].forEach(([opening, closing, body]) => {
  test(`tracks lambda parameters and Gemfile group exclusions across ${opening}`, () => {
    const gemfile = `group :test do
  module TestHelpers
    class TestHelper
      ${opening}
        ${body}
      ${closing}
    end
  end
  gem 'rspec'
end
gem 'rack'
warn /prefix
gem "ignored"
suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

test('keeps a defaulted lambda parameter local to the lambda', () => {
  const gemfile = `callback = ->(warn = 4) do
  warn /2
end
warn /prefix
gem 'ignored'
suffix/
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

[
  'warn', 'warn if true', 'warn unless false', 'warn then',
  '[warn]', '[0, warn]', '[0, *warn]', '[[warn]]', '[0, [1, [2, *warn]]]',
  '{warn:}', '{other: 0, warn:}', '[{warn:}]', '{nested: {warn:}}',
  '{value: warn}', '{value: warn, other: 0}', '{nested: {value: warn}}',
].forEach((pattern) => {
  test(`recognizes division after a pattern binds warn with ${pattern}`, () => {
    const gemfile = `group :test do
  module TestHelpers
    class Matcher
      case values
      in ${pattern}
        warn /2
        gem 'minitest'
      end
      warn /2
    end
  end
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'minitest'), false);
  });
});

['[^([[warn]])]', '{warn: 4}', '[^({warn: 4})]', '{value: ^warn}'].forEach((pattern) => {
  test(`recognizes a warn regexp after a pattern without a binding in ${pattern}`, () => {
    const gemfile = `group :test do
  case values
  in ${pattern}
    warn /prefix
class RegexpText
gem "ignored"
suffix/
  end
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

[
  ['warn', '[4]'],
  ['other, (warn, third)', '[[1, [4, 8]]]'],
].forEach(([targets, values]) => {
  test(`recognizes division inside and after a for loop binding ${targets}`, () => {
    const gemfile = `group :test do
  class TestHelper
    for ${targets} in ${values}
      warn /2
      gem 'rspec'
    end
    warn /2
    gem 'minitest'
  end
end
gem 'rack'
matcher = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'minitest'), false);
  });
});

[
  ['[4].each do |warn|', 'end'],
  ['[4].each { |warn|', '}'],
].forEach(([opening, closing]) => {
  test(`stops treating warn as a local after ${opening}`, () => {
    const gemfile = `group :test do
  ${opening}
    [2].each do |divisor|
      warn /divisor
    end
  ${closing}
  warn /prefix
class RegexText
gem "ignored"
suffix/
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

['warn, other', 'other, warn', 'other, (warn, third)', 'other, *warn'].forEach((targets) => {
  test(`recognizes a production gem after dividing warn assigned by ${targets}`, () => {
    const gemfile = `group :test do
  module TestHelpers
    class Helper
      ${targets} = 4, 8
      warn /2
      gem 'rspec'
    end
  end
end
gem 'rack'
warn /prefix
gem "ignored"
suffix/`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

['class TestHelper', 'module TestHelpers', 'class <<self', 'result = class TestHelper'].forEach((definition) => {
  test(`resolves warn in its local scope across ${definition}`, () => {
    const gemfile = `warn = 12
group :test do
  ${definition}
    warn /prefix
class RegexText
gem "ignored"
suffix/
  end
  gem 'rspec'
end
warn /2
gem 'rack'
matcher = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'ignored'), false);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('keeps a namespace local assignment inside its namespace', () => {
  const gemfile = `class TestHelper
  warn = 12
  warn /2
end
warn /prefix
class RegexText
gem "ignored"
suffix/
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['def helper(warn)', 'def helper warn', 'def helper(warn = 4)', 'def self.helper(value, warn: 4)'].forEach((definition) => {
  test(`distinguishes division by a method parameter from a later warn regexp after ${definition}`, () => {
    const gemfile = `group :test do
  ${definition}
    warn /2
  end
  gem 'rspec'
end
gem 'rack'
warn /prefix
gem "ignored"
suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

const regexpExpressions = [
  ['slash delimiters', '/prefix\nclass RegexText\nend\ngem "ignored"\nsuffix/i'],
  ['a preceding slash character literal', '?/\n  matcher = /prefix\nclass RegexText\nsuffix/'],
  ['an interpolated slash character literal', '/#{ ?/.ord / 2 }/'],
  ['unary negation', '!/prefix\nclass RegexText\nsuffix/'],
  ['the right operand of addition', '1 + /prefix\nclass RegexText\nsuffix/'],
  ['the right operand of subtraction', '12 - /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of multiplication', '1 * /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of division', '120 / /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of modulo', '120 % /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['a percent regexp after modulo', '120 % %r{prefix\nclass RegexText\ngem "ignored"\nsuffix}.source.length'],
  ['the right operand of bitwise AND', '1 & /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of bitwise OR', '1 | /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of bitwise XOR', '1 ^ /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source.length'],
  ['the right operand of less-than', '"" < /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source'],
  ['the right operand of greater-than', '"" > /prefix\nclass RegexText\ngem "ignored"\nsuffix/.source'],
  ['the right operand of or', 'false or /prefix\nclass RegexText\nsuffix/'],
  ['the right operand of and', 'true and /prefix\nmodule RegexText\nsuffix/'],
  ['percent delimiters', '%r!prefix\nclass RegexText\nsuffix!'],
  ['paired percent delimiters', '%r{prefix{nested}\nclass RegexText\nsuffix}'],
  ['the first ternary branch', 'true ? /prefix\nclass RegexText\nsuffix/ : nil'],
  ['the second ternary branch', 'false ? nil : /prefix\nclass RegexText\nsuffix/'],
  ['an interpolated quoted slash', '/#{"/"}/'],
  ['an interpolated regexp', '/#{ /\\// }/'],
  ['an interpolated percent string and division', '/#{ %q!}!.ord / 2 }/'],
];

test('recognizes division after the right operand of subtraction', () => {
  const gemfile = `group :test do
  ratio = 12 - 6 / 2
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

regexpExpressions.forEach(([description, expression]) => {
  test(`preserves group exclusions around a regexp with ${description}`, () => {
    const gemfile = `group :test do
  matcher = ${expression}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'ignored'), false);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('distinguishes a conditional regexp from division after keyword-named methods', () => {
  const gemfile = `group :test do
  if /prefix
class RegexText
suffix/
  end
  gem 'rspec'
end
ratio = receiver.if / 2
ratio = receiver.or / 2
ratio = receiver.and / 2
ratio = receiver.not / 2
gem 'rack', path: '/rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('preserves group exclusions around a multiline regexp after not', () => {
  const gemfile = `group :test do
  not /prefix
class RegexText
gem "ignored"
suffix/
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('distinguishes a warn regexp argument from division', () => {
  const gemfile = `group :test do
  warn /prefix
class RegexText
gem "ignored"
suffix/
  gem 'rspec'
end
warn = 12
warn / 2
gem 'rack'
warn/2
gem 'rake'
ratio = warn /2
gem 'rails'
warn /2
gem 'json'
matcher = /suffix/`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
  assert.equal(isProductionGem(gemfile, 'rake'), true);
  assert.equal(isProductionGem(gemfile, 'rails'), true);
  assert.equal(isProductionGem(gemfile, 'json'), true);
});

test('recognizes division after a compact local assignment with a parenthesized value', () => {
  const gemfile = `warn=(12)
group :test do
  module TestHelpers
    class Runner; end
  end
  gem 'rspec'
end
warn /2
gem 'rack'
matcher = /suffix/`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['@', '@@', '$', 'receiver.'].forEach((prefix) => {
  test(`distinguishes a warn regexp argument from assignment to ${prefix}warn`, () => {
    const gemfile = `${prefix}warn = 12
${prefix}warn=(12)
group :test do
  warn /prefix
class RegexText
gem 'ignored'
suffix/
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'ignored'), false);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['||=', '&&=', '+=', '/=', '<<='].forEach((operator) => {
  test(`recognizes division after a local binding with ${operator}`, () => {
    const gemfile = `warn ${operator} 12
group :test do
  class TestHelper; end
  warn /2
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('recognizes a regexp on the right of a compound assignment', () => {
  const gemfile = `group :test do
  matcher ||= /=prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

[
  ['a multiline percent string', 'message = %q{prefix{nested}\nclass LiteralText\ngem "ignored"\nsuffix}'],
  ['a multiline Kernel.warn regexp', 'Kernel.warn /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline logger.warn regexp', 'logger.warn /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline puts regexp', 'puts /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline Kernel.puts regexp', 'Kernel.puts /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline print regexp', 'print /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline Kernel.print regexp', 'Kernel.print /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline p regexp', 'p /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline Kernel.p regexp', 'Kernel.p /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline abort regexp', 'abort /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline Kernel.abort regexp', 'Kernel.abort /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline regexp passed to a custom method', 'register_pattern /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
  ['a multiline regexp passed to a custom receiver method', 'registry.register_pattern /prefix\nclass LiteralText\ngem "ignored"\nsuffix/'],
].forEach(([description, statement]) => {
  test(`preserves group exclusions around ${description}`, () => {
    const gemfile = `group :test do
  warn = 12
  ${statement}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

['warn', 'Kernel.warn', 'abort', 'register_pattern'].forEach((command) => {
  test(`preserves group exclusions around a multiline percent regexp passed to ${command}`, () => {
    const gemfile = `group :test do
  ${command} %r!prefix
class LiteralText
gem 'ignored'
suffix!
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

test('keeps modulo of a local variable named warn visible', () => {
  const gemfile = `warn = 12
group :test do
  warn %r!
  gem 'rspec'
end
gem 'rack'
matcher = %r!suffix!`;

  assert.equal(isProductionGem(gemfile, 'rack'), true);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
});

test('keeps division after an explicit warn call visible', () => {
  const gemfile = `group :test do
  logger.warn / 2
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('keeps division of a numeric literal visible', () => {
  const gemfile = `group :test do
  12 /2
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['puts', 'print', 'p', 'abort', 'register_pattern'].forEach((name) => {
  test(`keeps division of a local variable named ${name} visible`, () => {
    const gemfile = `${name} = 12
group :test do
  ${name} /2
  gem 'rspec'
end
gem 'rack'
matcher = /suffix/`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('recognizes a production gem after division by a rescue variable', () => {
  const gemfile = `group :test do
  class TestHelper
    begin
      raise 'error'
    rescue => warn
      warn /2
    end
  end
  gem 'rspec'
end
gem 'rack'
another_ratio = 8 / 2`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});
