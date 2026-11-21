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

[
  ['slash regexp', "pattern = /first\\/part\nclass Fake\nmodule Fake\ngem 'ignored'\nlast/im"],
  ['regexp after unary bang', "pattern = !/first\nclass Fake\ngem 'ignored'\nlast/"],
  ['regexp passed to puts', "puts /first\nclass Fake\ngem 'ignored'\nlast/"],
  ['regexp passed to print', "print /first\nclass Fake\ngem 'ignored'\nlast/"],
  ['regexp passed to a custom helper', "helper /first\nclass Fake\ngem 'ignored'\nlast/"],
  ['percent regexp', "pattern = %r{first{nested}\nclass Fake\ngem 'ignored'\nlast}x"],
  ['regexp after and', "true and /first\nclass Fake\ngem 'ignored'\nlast/"],
  ['regexp after or', "false or %r{first\nmodule Fake\ngem 'ignored'\nlast}"],
  ['ternary regexp branches', "enabled = true; pattern = enabled ?/first\nclass Fake\nlast/ : /first\nend\nlast/"],
  ['nested regexp and percent string interpolation', "pattern = /#{[/a\\/b/, %q(}/), { key: 1 }]}\nclass Fake\ngem 'ignored'\nlast/"],
  ['division after a method name in regexp interpolation', "pattern = /#{receiver.if / 2}\nend\ngem 'ignored'\nlast/"],
  ['character literal in regexp interpolation', "pattern = /#{?{}\nend\ngem 'ignored'\nlast/"],
].forEach(([description, expression]) => {
  test(`ignores Gemfile scope tokens inside ${description}`, () => {
    const gemfile = `group :test do
${expression}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('keeps a slash character literal separate from the following gem path', () => {
  const gemfile = `group :test do
  class TestHelper; end
  separator = ?/
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('preserves group boundaries around division and modulo', () => {
  const gemfile = `group :test do
  count = 12 / 3
  count = receiver.if / 2
  remainder = count % 3
  puts = 12
  count = puts / 2
  count = puts/2
  gem 'rspec'
end
gem 'rack'
other = 12 / 4`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

for (const variable of ['@puts', '@@puts', '$warn']) {
  test(`keeps division after ${variable} separate from the following gem path`, () => {
    const gemfile = `group :test do
  module TestHelpers
    class TestHelper; end
  end
  ${variable} = 12
  ${variable} /2
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}

for (const command of ['puts', 'warn', 'print', 'helper']) {
  for (const assignment of [
    `${command} = 12`,
    `${command} ||= 12`,
    `${command} &&= 12`,
    `${command} += 2`,
    `${command}, count = 12, 1`,
    `count, ${command}, other = 1, 12, 2`,
    `${command}, count=([12, 1])`,
  ]) {
    test(`keeps division after ${assignment} separate from the following gem path`, () => {
      const gemfile = `group :test do
  module TestHelpers
    class TestHelper; end
  end
  gem 'rspec'
end
${assignment}
${command} /2
gem 'rack', path: '/rack'`;

      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
    });
  }

  for (const separateScope of ['helper do', 'class Helpers', 'module Helpers', 'def helper']) {
    test(`recognizes a ${command} regexp after a local assignment in ${separateScope}`, () => {
      const gemfile = `${separateScope}
  ${command} = 12
end
group :test do
  ${command} /prefix
class RegexText
gem 'ignored'
suffix/
  gem 'rspec'
end
gem 'rack'`;

      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'ignored'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
    });
  }
}

test('inherits an outer puts local in a block and retains assignments in conditionals', () => {
  const gemfile = `if true
  puts = 12
end
group :test do
  puts /2
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('recognizes a command regexp after the command name appears in an argument list', () => {
  const gemfile = `record(puts, count = 12)
group :test do
  puts /first
end
gem 'ignored'
last/
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'ignored'), false);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

for (const signature of ['helper(puts)', 'helper puts', 'self.helper(prefix, *warn)']) {
  test(`keeps division by a method parameter within def ${signature}`, () => {
    const parameter = signature.includes('warn') ? 'warn' : 'puts';
    const gemfile = `group :test do
  module TestHelpers
    def ${signature}
      ${parameter} /2
    end
  end
  gem 'rspec'
end
${parameter} /first
class Fake
gem 'ignored'
end
last/
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}

for (const [opener, closer] of [
  ['group :test do |puts|', 'end'],
  ['group(:test) { |prefix, puts; scratch|', '}'],
  ['group :test do |(prefix, puts)|', 'end'],
  ['group :test do |puts = 12|', 'end'],
  ['group :test do |prefix = [1, 2], puts = 12|', 'end'],
  ['group :test do |puts: 12|', 'end'],
  ['group :test do |; puts|', 'end'],
]) {
  test(`keeps division by a block local within ${opener}`, () => {
    const gemfile = `${opener}
  module TestHelpers
    class TestHelper; end
  end
  puts /2
  gem 'rspec'
${closer}
gem 'rack', path: '/rack'
group :test do
  puts /first
class Fake
gem 'ignored'
last/
end`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
}

for (const [description, loop] of [
  ['in the loop body', 'for puts in [12]\n  puts /2\nend'],
  ['with multiple loop targets and do', 'for prefix, warn in [[1, 12]] do\n  warn /2\nend'],
  ['in the iterable', 'for print in [12, print /2]; end'],
  ['after the loop', 'for puts in [12]; end\nputs /2'],
]) {
  test(`keeps division by a loop variable separate from the gem path ${description}`, () => {
    const gemfile = `group :test do
  module TestHelpers
    class TestHelper; end
  end
  ${loop}
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}
