import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

const dialects = [
  { file: 'build.gradle', declaration: (configuration, coordinate) => `${configuration} '${coordinate}'` },
  { file: 'build.gradle.kts', declaration: (configuration, coordinate) => `${configuration}("${coordinate}")` },
];

dialects.forEach(({ file, declaration }) => {
  ['implementation', 'api'].forEach((configuration) => {
    test(`${file}: matches the target production declaration in ${configuration}`, async (t) => {
      const content = `dependencies {
        ${declaration(configuration, 'org.example:runtime:1.0')}
        ${declaration('testImplementation', 'junit:junit:4.13.2')}
        ${declaration('testApi', 'org.example:test-api:1.0')}
        ${declaration('runtimeOnly', 'org.example:runtime-only:1.0')}
      }`;
      const getContent = t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
        data: { content: Buffer.from(path === file ? content : '').toString('base64') },
      }));
      const check = (pkg) => isProductionDependency('owner', 'repo', pkg, 'kotlin');

      assert.equal(await check('org.example:runtime'), true);
      assert.equal(await check('junit:junit'), false);
      assert.equal(await check('org.example:test-api'), false);
      assert.equal(await check('org.example:runtime-only'), false);
      assert.equal(await check('org.example:run'), false);
      assert.equal(await check('org.example:missing'), false);
      assert.equal(getContent.mock.calls[0].arguments[0].path, 'build.gradle');
      getContent.mock.restore();
    });
  });
});

test('Kotlin declarations accept whitespace, single quotes, and unversioned coordinates', async (t) => {
  const content = `dependencies {
    implementation (
      'org.example:runtime'
    )
    api("org.example:public:1.0")
  }`;
  t.mock.method(getOctokit().repos, 'getContent', async () => ({
    data: { content: Buffer.from(content).toString('base64') },
  }));

  assert.equal(await isProductionDependency('owner', 'repo', 'org.example:runtime', 'kotlin'), true);
  assert.equal(await isProductionDependency('owner', 'repo', 'org.example:public', 'kotlin'), true);
});
