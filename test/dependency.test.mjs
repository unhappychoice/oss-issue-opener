import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, mock, test } from 'node:test';
import { isProductionDependency } from '../dist/dependency.js';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit } from '../dist/github.js';
import { mockRubyRepository } from './helpers/github.mjs';

afterEach(() => mock.restoreAll());

const check = (pkg) => isProductionDependency('owner', 'repo', pkg, 'ruby');

[
  ["spec.add_dependency 'rake', '~> 13'", 'rake', true],
  ["# spec.add_dependency 'rack', '~> 3.0'", 'rack', false],
  ['  # spec.add_dependency("rack", "~> 3.0")', 'rack', false],
  ["# spec.add_dependency(\n#   'rack', '~> 3.0'\n# )", 'rack', false],
  ["spec.add_development_dependency 'rack' # spec.add_dependency 'rack'", 'rack', false],
  ["spec.add_dependency( # runtime dependency\n  'rack', '~> 3.0'\n)", 'rack', true],
  ["spec.add_dependency # runtime dependency\n  'rack', '~> 3.0'", 'rack', true],
  ["spec.add_dependency 'rack#test' # trailing comment", 'rack#test', true],
  ['spec.add_dependency "rack#test" # trailing comment', 'rack#test', true],
  ["spec.summary = 'A # character'\nspec.add_dependency 'rack'", 'rack', true],
  ['spec.summary = "A \\"quoted\\" # character"\nspec.add_dependency "rack"', 'rack', true],
  ['spec.add_dependency("rake", ">= 13")', 'rake', true],
  ["spec.add_dependency(\n  'rack', '~> 3.0'\n)", 'rack', true],
  ['spec.add_dependency(\n  "rack", "~> 3.0"\n)', 'rack', true],
  ["spec.add_dependency \n  'rack', '~> 3.0'", 'rack', true],
  ["spec.add_dependency(\n  'rackXtest'\n)", 'rack.test', false],
  ["spec.add_dependency(\n  'rack.test'\n)", 'rack.test', true],
  ["spec.add_dependency(\n  'rake-extra'\n)", 'rake', false],
  ["spec.add_development_dependency(\n  'rack'\n)", 'rack', false],
  ["spec.add_dependency 'other'; spec.add_development_dependency 'rack'", 'rack', false],
  ["spec.add_dependency(\n  'other'\n)\nspec.add_development_dependency(\n  'rack'\n)", 'rack', false],
  ["spec.add_dependency 'other', 'rack'", 'rack', false],
  ["spec.add_dependency 'rake-extra'", 'rake', false],
  ["spec.add_development_dependency 'rake'", 'rake', false],
  ["spec.add_dependency 'rake'", 'rack', false],
  ["spec.add_dependency 'rackXtest'", 'rack.test', false],
  ["spec.add_dependency 'aaaa'", 'a+', false],
  ["spec.add_dependency 'rake'", 'rake|rack', false],
  ...['(a+)+$', 'a.b', 'a*b', 'a?b', '^a', 'a{2}', '[a]', 'a|b', 'a\\b']
    .map((pkg) => [`spec.add_dependency '${pkg}'`, pkg, true]),
].flatMap(([gemspec, pkg, expected]) =>
  [...new Set([gemspec, gemspec.replace('add_dependency', 'add_runtime_dependency')])]
    .map((declaration) => [declaration, pkg, expected])
).forEach(([gemspec, pkg, expected]) => {
  test(`gemspec matches ${JSON.stringify(pkg)} literally in ${JSON.stringify(gemspec)}`, async () => {
    mockRubyRepository(gemspec, 'source "https://rubygems.org"\ngemspec');
    assert.equal(await check(pkg), expected);
  });
});

['add_dependency', 'add_runtime_dependency', 'add_development_dependency'].flatMap((method) =>
  [`spec.${method} "rack", "~> 3.0"`, `spec.${method}(\n  'rack', '~> 3.0'\n)`]
    .map((declaration) => ({ method, declaration }))
).forEach(({ method, declaration }) => {
  test(`release checks classify ${JSON.stringify(declaration)} updates without source changes`, async () => {
    mockRubyRepository(declaration, 'source "https://rubygems.org"\ngemspec');
    mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'example.gemspec' }, { filename: 'Gemfile.lock' }],
      commits: [{ commit: { message: 'Bump rack from 3.0.0 to 3.1.0' } }],
    } }));

    assert.equal(await check('rack'), method !== 'add_development_dependency');
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'),
      method === 'add_development_dependency' ? { status: 'up-to-date' } : {
        status: 'pending',
        reasons: '**Dependency updates:**\n- rack 3.0.0 -> 3.1.0',
        compareUrl: 'https://github.com/owner/repo/compare/v1...main',
      });
  });
});

['add_dependency', 'add_runtime_dependency'].forEach((method) => {
  test(`release checks ignore commented ${method} beside development dependencies`, async () => {
    mockRubyRepository(`spec.add_development_dependency 'rack', '~> 3.0'
      # spec.${method} 'rack', '~> 3.0'`, 'gemspec');
    mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'Gemfile.lock' }],
      commits: [{ commit: { message: 'Bump rack from 3.0.0 to 3.1.0' } }],
    } }));

    assert.equal(await check('rack'), false);
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), { status: 'up-to-date' });
  });
});

test('Gemfile fallback matches package names literally', async () => {
  mockRubyRepository('', "gem 'rackXtest'\ngem '(a+)+$'");
  assert.equal(await check('rack.test'), false);
  assert.equal(await check('(a+)+$'), true);
  assert.equal(await check('['), false);
});

test('Gemfile fallback preserves group exclusions for literal package names', async () => {
  mockRubyRepository('', `group :test do
    gem '(a+)+$'
  end
  gem 'rack.test', group: :development
  gem('runtime.test')`);
  assert.equal(await check('(a+)+$'), false);
  assert.equal(await check('rack.test'), false);
  assert.equal(await check('runtime.test'), true);
  assert.equal(await check('runtimeXtest'), false);
});

test('malicious bump completes and the next repository is checked', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { checkPendingRelease } from './dist/checker.js';
    import { mockRubyRepository } from './test/helpers/github.mjs';
    mockRubyRepository(
      "# spec.add_dependency '" + 'a'.repeat(32) + "!'\\n" +
      "spec.add_dependency 'rake'",
      "gem '" + 'a'.repeat(32) + "!'"
    );
    assert.equal((await checkPendingRelease('owner', 'malicious', 'ruby')).status, 'up-to-date');
    const next = await checkPendingRelease('owner', 'next', 'ruby');
    assert.equal(next.status, 'pending');
    assert.match(next.reasons, /rake 1 -> 2/);
  `], { cwd: new URL('..', import.meta.url), timeout: 3000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
