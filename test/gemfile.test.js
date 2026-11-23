import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProductionGem, productionGemNames } from '../dist/gemfile.js';
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
      data: path === '' ? [{ name: 'Gemfile' }] : gemfile,
    }));
    assert.equal(await isProductionDependency('owner', 'repo', 'rake', 'ruby'), expected);
  });
});

test('gemspec runtime dependencies take precedence over Gemfile groups', async (t) => {
  t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
    data: path === '' ? [{ name: 'example.gemspec' }, { name: 'Gemfile' }]
      : path.endsWith('.gemspec') ? "spec.add_dependency 'rake'" : "gem 'rake', group: :test",
  }));
  assert.equal(await isProductionDependency('owner', 'repo', 'rake', 'ruby'), true);
});

test('ignores bare dependency names in Gemfile declarations', () => {
  const gemfile = "rack = 'puma'\ngem rack\ngem(rack)";
  assert.equal(isProductionGem(gemfile, 'rack'), false);
  assert.equal(isProductionGem(gemfile, 'puma'), false);
});

test('tracks excluded and shared groups through deeply nested scopes', () => {
  const depth = 4_096;
  const names = productionGemNames([
    'group :test, :production do\n'.repeat(depth),
    "gem 'shared'",
    'group :development do',
    'group :production do\n'.repeat(depth),
    'group :test do',
    "gem 'inner_test'",
    'end',
    "gem 'after_test'",
    'end\n'.repeat(depth),
    "gem 'after_production'",
    'end',
    "gem 'after_development'",
    'end\n'.repeat(depth),
    "gem 'ungrouped'",
  ].join('\n'));

  for (const pkg of ['shared', 'after_development', 'ungrouped']) {
    assert.equal(names.has(pkg), true, pkg);
  }
  for (const pkg of ['inner_test', 'after_test', 'after_production', 'missing']) {
    assert.equal(names.has(pkg), false, pkg);
  }
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
        data: path === '' ? [{ name: 'Gemfile' }] : gemfile,
      }));
      assert.equal(isProductionGem(gemfile, 'rspec'), false);
      assert.equal(isProductionGem(gemfile, 'rack'), true);
      assert.equal(await isProductionDependency('owner', 'repo', 'rspec', 'ruby'), false);
      assert.equal(await isProductionDependency('owner', 'repo', 'rack', 'ruby'), true);
    });
  });
});

const namespaceDefinitions = [
  'class TestHelper\nend',
  'module TestHelpers\n  class TestHelper < Object\n  end\nend',
  'result = class TestHelper; end',
  'result = module TestHelpers; end',
  'result ||= class TestHelper\n  end',
  'result &&= module TestHelpers; end',
  'class <<self; end',
  'class << self; end',
  'result = class <<self; end',
  'result ||= class <<self; end',
  'class <<self\n=begin\nend\ngem "ignored"\n=end\nend',
  'consume(result = class TestHelper; end)',
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

test('recognizes a heredoc argument after a method named class', () => {
  const gemfile = "receiver.class <<TEXT\ngem 'rspec'\nTEXT\ngem 'rack'";
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

for (const division of ['12 /\n  3', '12/3', '12/input', '12/ 3', '12/ input']) {
  test(`finds production gems between divisions ending with ${JSON.stringify(division)}`, () => {
    const gemfile = `def ratio(warn)
  warn /2
end
gem 'rack'
input = 3
result = ${division}`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}

test('preserves declarations after division of a local variable before a regexp', () => {
  const gemfile = `input = 12
result = input /2
gem 'rack'
pattern = /end/`;

  assert.equal(isProductionGem(gemfile, 'rack'), true);
});

for (const [opening, closing] of [
  ['do |amount|', 'end'],
  ['{ |amount|', '}'],
  ['do |first, (amount, last); scratch|', 'end'],
]) {
  test(`preserves Gemfile groups and declarations after block parameter division in ${opening}`, () => {
    const gemfile = `group :test do
  values.each ${opening}
    values.each do
      amount /2
    end
  ${closing}
  gem 'rspec'
end
gem 'rack', path: '/rack'
amount /start
gem 'fake'
finish/`;

    assert.deepEqual([...productionGemNames(gemfile)], ['rack']);
  });
}

for (const operator of ['||=', '&&=', '+=', '**=', '<<=', '/=']) {
  test(`finds a production gem with a path after division of a local assigned with ${operator}`, () => {
    const gemfile = `input ${operator} 12
input /2
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}

for (const targets of ['input, divisor', 'first, input, last', 'first,\n  input, last']) {
  test(`preserves gem paths after dividing a local assigned by ${JSON.stringify(targets)}`, () => {
    const gemfile = `${targets} = [12, 8, 4]
result = input /2
gem 'rack', path: '/rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
  });
}

for (const definition of [
  'def ratio(warn)\n  if warn\n    warn /2\n  end\nend',
  'def ratio(warn) = warn /2',
  'def ratio(\n  warn\n)\n  warn /2\nend',
  'class Helper\n  warn = 12\n  warn /2\nend',
  'module Helper\n  warn = 12\n  warn /2\nend',
]) {
  test(`recognizes a command regexp outside ${JSON.stringify(definition)}`, () => {
    const gemfile = `${definition}
group :test do
  warn /start
class RegexText
gem 'fake'
finish/
  gem 'rspec'
end
gem 'rack'`;

    assert.deepEqual([...productionGemNames(gemfile)], ['rack']);
  });
}

for (const [opening, closing] of [
  ['warn(/', '/)'],
  ['warn /', '/'],
  ['Kernel.warn /', '/'],
  ['message = warn /', '/'],
]) {
  test(`ignores scope keywords inside a multiline regexp after ${opening}`, () => {
    const gemfile = `group :test do
  ${opening}start
class RegexText
gem 'fake'
finish${closing}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'fake'), false);
  });
}

for (const [opening, closing] of [['/', '/x'], ['%r{', 'nested{pattern}}x']]) {
  test(`ignores scope keywords inside a multiline ${opening} regexp`, () => {
    const gemfile = String.raw`group :test do
  pattern = ${opening}
class RegexText
gem 'fake'
escaped \/ delimiter
${closing}
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'fake'), false);
  });
}

for (const [opening, closing, expression] of [
  ['/', '/', '12 / 3'],
  ['/', '/', '{path: "/}"}.fetch(:path)'],
  ['%r{', '}', '%q!}!'],
  ['%r(', ')', '%Q!#{")"}!'],
  ['/', '/', '(/inner\\//).source'],
  ['/', '/', '12 / 3 # } /\n  '],
  ['/', '/', '%!}/!'],
  ['/', '/', '12 % 5 / 2'],
]) {
  test(`preserves Gemfile groups around regexp interpolation containing ${JSON.stringify(expression)}`, () => {
    const gemfile = `group :test do
  pattern = ${opening}#{${expression}}
end
gem 'fake'
${closing}x
  gem 'rspec'
end
gem 'rack'`;

    assert.equal(isProductionGem(gemfile, 'rack'), true);
    assert.equal(isProductionGem(gemfile, 'rspec'), false);
    assert.equal(isProductionGem(gemfile, 'fake'), false);
  });
}

test('ignores scope keywords inside regexps in both ternary branches', () => {
  const gemfile = `group :test do
  pattern = condition ? /
end
gem 'fake_first'
/ : /
end
gem 'fake_second'
/
  gem 'rspec'
end
gem 'rack'`;

  assert.equal(isProductionGem(gemfile, 'rack'), true);
  assert.equal(isProductionGem(gemfile, 'rspec'), false);
  assert.equal(isProductionGem(gemfile, 'fake_first'), false);
  assert.equal(isProductionGem(gemfile, 'fake_second'), false);
});
