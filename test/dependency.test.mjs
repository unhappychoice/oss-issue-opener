import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, mock, test } from 'node:test';
import { isProductionDependency } from '../dist/dependency.js';
import { mockRubyRepository } from './helpers/github.mjs';

afterEach(() => mock.restoreAll());

const check = (pkg) => isProductionDependency('owner', 'repo', pkg, 'ruby');

[
  ["spec.add_dependency 'rake', '~> 13'", 'rake', true],
  ['spec.add_dependency("rake", ">= 13")', 'rake', true],
  ["spec.add_dependency 'rake-extra'", 'rake', false],
  ["spec.add_development_dependency 'rake'", 'rake', false],
  ["spec.add_dependency 'rake'", 'rack', false],
  ["spec.add_dependency 'rackXtest'", 'rack.test', false],
  ["spec.add_dependency 'aaaa'", 'a+', false],
  ["spec.add_dependency 'rake'", 'rake|rack', false],
  ...['(a+)+$', 'a.b', 'a*b', 'a?b', '^a', 'a{2}', '[a]', 'a|b', 'a\\b']
    .map((pkg) => [`spec.add_dependency '${pkg}'`, pkg, true]),
].forEach(([gemspec, pkg, expected]) => {
  test(`gemspec matches ${JSON.stringify(pkg)} literally in ${JSON.stringify(gemspec)}`, async () => {
    mockRubyRepository(gemspec);
    assert.equal(await check(pkg), expected);
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
