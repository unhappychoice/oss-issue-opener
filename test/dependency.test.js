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

const cases = [
  ['ordinary dependencies', '[dependencies]\nserde = "1"', 'serde', true],
  ['individual tables', '[dependencies.serde]\nversion = "1"', 'serde', true],
  ['target dependencies', '[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"', 'libc', true],
  ['target individual tables', '[target.\'cfg(unix)\'.dependencies.libc]\nversion = "0.2"', 'libc', true],
  ['target triples', '[target.x86_64-unknown-linux-gnu.dependencies]\nlibc = "0.2"', 'libc', true],
  ['quoted keys and whitespace', '[ dependencies . "serde" ] # comment\nversion = "1"', 'serde', true],
  ['inline dependency tables', '[dependencies]\nserde = { version = "1", features = ["derive"] }', 'serde', true],
  ['multiple dependencies', '[dependencies]\nserde = { version = "1", features = ["derive"] }\nlibc = "0.2"', 'libc', true],
  ['later targets', '[target.\'cfg(windows)\'.dependencies]\nwinapi = "0.3"\n[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"', 'libc', true],
  ['missing dependencies', '[dependencies]\nserde = "1"', 'libc', false],
  ['exact package names', '[dependencies]\nserde_json = "1"', 'serde', false],
  ['commented declarations', '[dependencies]\n# serde = "1"', 'serde', false],
  ['workspace declarations', '[workspace.dependencies]\nserde = "1"', 'serde', false],
  ['workspace references', '[dependencies.serde]\nworkspace = true', 'serde', true],
  ['metadata', '[package.metadata.dependencies]\nserde = "1"', 'serde', false],
  ['strings containing declarations', '[package]\ndescription = """\n[dependencies]\nserde = "1"\n"""', 'serde', false],
  ['inherited property names', '[dependencies]\nserde = "1"', 'constructor', false],
  ['empty files', '', 'serde', false],
  ['invalid TOML', '[dependencies\nserde = "1"', 'serde', false],
];

['dev-dependencies', 'build-dependencies'].forEach((kind) => {
  ['', "target.'cfg(unix)'."].forEach((prefix) => {
    cases.push(
      [`${prefix}${kind}`, `[${prefix}${kind}]\nserde = "1"`, 'serde', false],
      [`${prefix}${kind} individual tables`, `[${prefix}${kind}.serde]\nversion = "1"`, 'serde', false],
    );
  });
});

cases.forEach(([name, content, pkg, expected]) => {
  test(`Rust production dependency detection: ${name}`, async (t) => {
    const getContent = t.mock.method(getOctokit().repos, 'getContent', async () => ({
      data: { content: Buffer.from(content).toString('base64') },
    }));

    assert.equal(await isProductionDependency('owner', 'repo', pkg, 'rust'), expected);
    assert.deepEqual(getContent.mock.calls[0].arguments, [{
      owner: 'owner', repo: 'repo', path: 'Cargo.toml',
    }]);
  });
});
