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

const regexpExpressions = [
  ['slash literal', 'matcher = /prefix\nclass RegexText\nsuffix/'],
  ['slash literal after compound assignment', 'matcher ||= /prefix\nclass RegexText\nsuffix/'],
  ['slash literal after and', 'enabled and /prefix\nclass RegexText\nsuffix/'],
  ['percent regexp after or', 'enabled or %r{prefix\nmodule RegexText\nsuffix}'],
  ['slash literal passed to puts', 'puts /prefix\nclass RegexText\nsuffix/'],
  ['numeric prefix in a regexp passed to puts', 'puts /2\nclass RegexText\nsuffix/'],
  ['slash literal after comparing puts', 'puts == nil\nputs /prefix\nclass RegexText\nsuffix/'],
  ['slash literal after assigning other locals', '(output, count) = [8, 1]\nputs /prefix\nclass RegexText\nsuffix/'],
  ['slash literal after nested assignment to other locals', '((output, count), rest) = [[8, 1], 2]\nputs /prefix\nclass RegexText\nsuffix/'],
  ['qualified puts after a local assignment', 'puts = 8\nKernel.puts /prefix\nclass RegexText\nsuffix/'],
  ['percent regexp passed to puts', 'puts %r{prefix\nmodule RegexText\nsuffix}'],
  ['slash literal passed to warn', 'warn /prefix\nclass RegexText\nsuffix/'],
  ['percent regexp passed to warn', 'warn %r{prefix\nmodule RegexText\nsuffix}'],
  ['qualified warn after a local assignment', 'warn = 8\nKernel.warn /prefix\nclass RegexText\nsuffix/'],
  ['return before a slash literal', 'def matcher\n  return /prefix\nclass RegexText\nsuffix/\nend'],
  ['return before a percent regexp', 'def matcher\n  return %r{prefix\nclass RegexText\nsuffix}\nend'],
  ['escaped delimiter and options', 'matcher = /prefix\\/\nclass RegexText\nsuffix/i'],
  ['paired percent regexp', 'matcher = %r{prefix{2}\nclass RegexText\nsuffix}'],
  ['case before a slash literal', 'case /prefix\nclass RegexText\nsuffix/\nwhen Regexp\n  nil\nend'],
  ['case before a percent regexp', 'case %r!prefix\nclass RegexText\nsuffix!\nwhen Regexp\n  nil\nend'],
  ['ternary branches', 'matcher = enabled ? /prefix\nclass RegexText\nsuffix/ : /prefix\nmodule RegexText\nsuffix/'],
  ['percent string inside interpolation', 'matcher = /prefix#{ %q!} /! }\nclass RegexText\nsuffix/'],
  ['nested regexp inside interpolation', 'matcher = /prefix#{ /[{]/ }\nclass RegexText\nsuffix/'],
  ['block end and gem declaration', "matcher = /prefix\nend\ngem 'ignored'\nsuffix/"],
  ['division inside interpolation', 'matcher = /prefix#{ 8 / 2 }\nclass RegexText\nsuffix/'],
  ['character literal inside interpolation', 'matcher = /prefix#{ ?/ }\nclass RegexText\nsuffix/'],
];

regexpExpressions.forEach(([name, expression]) => {
  test(`ignores scope keywords in a multiline regexp with ${name}`, () => {
    const gemfile = `group :test do
  ${expression}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'ignored'), false);
  });
});

test('preserves gem declarations between division expressions', () => {
  const gemfile = "ratio = 8 /2\ngem 'rack'\nratio /2";
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('preserves gem declarations after dividing a local variable named warn', () => {
  const gemfile = "warn = 8\nwarn /2\ngem 'rack', path: '/rack'";
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['@puts', '@@puts', '$puts'].forEach((variable) => {
  test(`preserves gem declarations after dividing ${variable}`, () => {
    const gemfile = `${variable} /2\ngem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  'puts = 8',
  'puts ||= 8',
  'puts &&= 8',
  'puts += 8',
  'puts -= 8',
  'puts *= 8',
  'puts /= 8',
  'puts %= 8',
  'puts **= 8',
  'puts <<= 8',
  'puts >>= 8',
  'puts &= 8',
  'puts |= 8',
  'puts ^= 8',
  '(puts, count) = [8, 1]',
  'puts, count = [8, 1]',
  '((puts, count), rest) = [[8, 1], 2]',
  'count, (puts, *rest) = [1, [8, 2]]',
  '((count,\n  (value, puts)), tail) = [[1, [2, 8]], 3]',
].forEach((assignment) => {
  ['/ 2', '/2'].forEach((division) => {
    test(`preserves gem declarations after ${assignment} and puts ${division}`, () => {
      const gemfile = `${assignment}\nputs ${division}\ngem 'rack', path: '/rack'`;
      assert.equal(isProductionGem(gemfile, 'rack'), true);
    });
  });
});

test('preserves gem declarations after a slash character literal', () => {
  const gemfile = "separator = ?/\ngem 'rack', path: '/rack'";
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

['puts in [8]', '(count, puts) in [[1, 8]] do'].forEach((header) => {
  test(`recognizes division by a for loop variable in ${header}`, () => {
    const inside = `for ${header}\n  puts /2\nend`;
    const after = `for ${header}\nend\nputs /2`;
    [inside, after].forEach((expression) => {
      assert.equal(isProductionGem(`${expression}\ngem 'rack', path: '/rack'`, 'rack'), true);
    });
  });
});

test('recognizes a puts regexp after a loop that binds a different variable', () => {
  const gemfile = `group :test do
  for count in [8]
  end
  puts /prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack', path: '/rack'`;
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

test('keeps a for loop variable local to its enclosing block', () => {
  const gemfile = `[1].each do
  for puts in [8] do
    puts /2
  end
  gem 'rack', path: '/rack'
end
group :test do
  puts /prefix
end
suffix/
  gem 'rspec'
end`;
  assert.equal(isProductionGem(gemfile, 'rack'), true);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
});

[
  '[8].each do |puts|\n  puts /2\nend',
  '[8].each do |count, puts|\n  if true\n    puts /2\n  end\nend',
  '[8].each { |puts| puts /2 }',
  '[8].each do |count,\nputs|\n  puts /2\nend',
].forEach((block) => {
  test(`recognizes division by a block parameter in ${block}`, () => {
    assert.equal(isProductionGem(`${block}\ngem 'rack', path: '/rack'`, 'rack'), true);

    const gemfile = `${block}
group :test do
  puts /prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
  });
});

['render(puts)', 'render puts', 'render(count, puts = 8)'].forEach((signature) => {
  test(`preserves gem declarations after dividing a parameter in def ${signature}`, () => {
    const gemfile = `def ${signature}
  if true
    puts /2
  end
end
gem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['puts', 'puts = 8'].forEach((parameter) => {
  test(`recognizes a puts regexp after leaving def render(${parameter})`, () => {
    const gemfile = `def render(${parameter})
  puts /2
end
group :test do
  puts /prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

['puts = 8', 'puts, count = [8, 1]'].forEach((assignment) => {
  test(`keeps ${assignment} local to its method when scanning a Gemfile`, () => {
    const gemfile = `def render
  ${assignment}
  if true
    puts /2
  end
end
group :test do
  puts /prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack', path: '/rack'`;
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

[
  '[1].each do\n  puts = 8\n  puts /2\nend',
  '[1].each { puts = 8; puts /2 }',
  '[1].each do\n  if true\n    puts = 8\n  end\n  puts /2\nend',
].forEach((block) => {
  test(`isolates a command-name assignment in ${block}`, () => {
    const gemfile = `${block}
group :test do
  puts /prefix
class RegexText
suffix/
  gem 'rspec'
end
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
});

test('inherits a surrounding local assignment in nested blocks', () => {
  const gemfile = `puts = 8
[1].each do
  [1].each do
    puts /2
    gem 'rack', path: '/rack'
  end
end`;
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});
