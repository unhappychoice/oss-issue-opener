import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');
afterEach(() => mock.restoreAll());

const stubGoMod = (content) => {
  mock.method(getOctokit().repos, 'getContent', async ({ path }) => {
    assert.equal(path, 'go.mod');
    return { data: { content: Buffer.from(content).toString('base64') } };
  });
};

const cases = [
  ['comment only', 'module example.com/app\n\ngo 1.22\n\n// example.com/library is not required\n', false],
  ['module name prefix', 'require example.com/library-extra v1.0.0', false],
  ['module name suffix', 'require other.example.com/library v1.0.0', false],
  ['single requirement', 'require example.com/library v1.0.0', true],
  ['indirect requirement', 'require example.com/library v1.0.0 // indirect', true],
  ['require block', 'require (\n\texample.com/other v1.0.0\n\texample.com/library v1.2.0\n)', true],
  ['block comments', 'require (\n// example.com/library v1.0.0\nexample.com/other v1.0.0 // example.com/library\n)', false],
  ['other directives', 'module example.com/library\nreplace example.com/library => ../library\nexclude example.com/library v1.0.0', false],
  ['other blocks', 'replace (\nexample.com/library => ../library\n)\nexclude (\nexample.com/library v1.0.0\n)', false],
  ['closed require block', 'require (\nexample.com/other v1.0.0\n)\nexclude example.com/library v1.0.0', false],
  ['multiple require blocks', 'require (\nexample.com/other v1.0.0\n)\nrequire ( // dependencies\nexample.com/library v1.0.0\n)', true],
  ['tabs and CRLF', 'require\t(\r\n\texample.com/library\tv1.0.0 // indirect\r\n)\r\n', true],
  ['quoted module', 'require "example.com/library" v1.0.0', true],
  ['empty file', '', false],
];

cases.forEach(([name, content, expected]) => {
  test(`Go production dependency: ${name}`, async () => {
    stubGoMod(content);
    assert.equal(await isProductionDependency('owner', 'repo', 'example.com/library', 'go'), expected);
  });
});

const stubRelease = () => {
  const repos = getOctokit().repos;
  mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1.0.0' }] }));
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'go.mod' }, { filename: 'go.sum' }],
    commits: [{ commit: { message: 'Bump example.com/library from 1.0.0 to 1.1.0' } }],
  } }));
};

[false, true].forEach((required) => {
  test(`Pending release ${required ? 'includes' : 'ignores'} a Go dependency update`, async () => {
    stubRelease();
    stubGoMod(required ? 'require example.com/library v1.1.0' :
      '// example.com/library was removed\nrequire example.com/library-extra v1.1.0');
    const result = await checkPendingRelease('owner', 'repo', 'go');
    if (!required) return assert.deepEqual(result, { status: 'up-to-date' });
    assert.equal(result.status, 'pending');
    assert.match(result.reasons, /example\.com\/library 1\.0\.0 -> 1\.1\.0/);
  });
});
