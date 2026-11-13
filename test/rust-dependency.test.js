import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

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

['', "target.'cfg(unix)'.", 'target.x86_64-unknown-linux-gnu.'].forEach((prefix) => {
  const declarations = [
    `[${prefix}dependencies]\nserde_alias = { package = "serde", version = "1.0.219" }`,
    `[${prefix}dependencies.serde_alias]\npackage = "serde"\nversion = "1.0.219"`,
  ];
  declarations.forEach((content, index) => {
    cases.push(
      [`${prefix}aliased dependency ${index}`, content, 'serde', true],
      [`${prefix}alias is not a package name ${index}`, content, 'serde_alias', false],
      [`${prefix}aliased package names match exactly ${index}`, content, 'ser', false],
    );
  });
});

['dev-dependencies', 'build-dependencies'].forEach((kind) => {
  ['', "target.'cfg(unix)'."].forEach((prefix) => {
    cases.push(
      [`${prefix}${kind}`, `[${prefix}${kind}]\nserde = "1"`, 'serde', false],
      [`${prefix}${kind} individual tables`, `[${prefix}${kind}.serde]\nversion = "1"`, 'serde', false],
      [`${prefix}${kind} aliases`, `[${prefix}${kind}]\nserde_alias = { package = "serde", version = "1" }`, 'serde', false],
      [`${prefix}${kind} individual table aliases`, `[${prefix}${kind}.serde_alias]\npackage = "serde"\nversion = "1"`, 'serde', false],
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
