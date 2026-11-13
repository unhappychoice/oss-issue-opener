import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

const prefixes = ['Bump', 'chore(deps): bump', 'fix(deps): bump', 'chore: bump', 'chore(deps)!: bump'];

const stubRepository = (t, message) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1.0.0' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  t.mock.method(repos, 'compareCommits', async () => ({
    data: {
      files: [{ filename: 'package-lock.json' }],
      commits: [{ commit: { message } }],
    },
  }));
  t.mock.method(repos, 'getContent', async () => ({
    data: { content: Buffer.from(JSON.stringify({
      dependencies: { '@octokit/rest': '^22.0.1' },
      devDependencies: { typescript: '^7.0.2' },
    })).toString('base64') },
  }));
};

prefixes.forEach((prefix) => {
  test(`detects production dependency updates with ${prefix}`, async (t) => {
    stubRepository(t, `${prefix} @octokit/rest from 21.1.1 to 22.0.1\n\nCommit body`);

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
      status: 'pending',
      reasons: '**Dependency updates:**\n- @octokit/rest 21.1.1 -> 22.0.1',
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    });
  });

  test(`ignores development dependency updates with ${prefix}`, async (t) => {
    stubRepository(t, `${prefix} typescript from 7.0.1 to 7.0.2`);

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
  });
});

test('ignores bump text outside a dependency update subject', async (t) => {
  stubRepository(t, 'docs: explain how to Bump @octokit/rest from 21.1.1 to 22.0.1');

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});

['dependencies', 'dev-dependencies', 'build-dependencies'].forEach((kind) => {
  test(`checks Rust aliased ${kind} updates without source changes`, async (t) => {
    const message = 'Bump serde from 1.0.218 to 1.0.219';
    stubRepository(t, message);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
      data: {
        files: ['Cargo.toml', 'Cargo.lock'].map((filename) => ({ filename })),
        commits: [{ commit: { message } }],
      },
    }));
    t.mock.method(getOctokit().repos, 'getContent', async () => ({
      data: { content: Buffer.from(
        `[${kind}]\nserde_alias = { package = "serde", version = "1.0.219" }`
      ).toString('base64') },
    }));

    const expected = kind === 'dependencies' ? {
      status: 'pending',
      reasons: '**Dependency updates:**\n- serde 1.0.218 -> 1.0.219',
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    } : { status: 'up-to-date' };
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'rust'), expected);
  });
});

test('detects source changes without dependency updates', async (t) => {
  stubRepository(t, 'fix: handle empty input');
  t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: [{ filename: 'src/index.ts' }],
      commits: [{ commit: { message: 'fix: handle empty input' } }],
    },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    reasons: '**Source code changes:**\n- `src/index.ts`\n',
    compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
  });
});

[
  ["group :production, :test do\n  gem 'rack'\nend", true],
  ["group :development, :production do\n  gem 'rack'\nend", true],
  ["gem 'rack', groups: [:production, :test]", true],
  ["gem 'rack', groups: [:development, :production]", true],
  ["group :development, :test do\n  gem 'rack'\nend", false],
  ["gem 'rack', groups: [:development, :test]", false],
].forEach(([gemfile, production]) => {
  test(`checks Ruby dependency-only updates for ${gemfile}`, async (t) => {
    const message = 'Bump rack from 3.1.0 to 3.1.1';
    stubRepository(t, message);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
      data: {
        files: [{ filename: 'Gemfile.lock' }],
        commits: [{ commit: { message } }],
      },
    }));
    t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
      data: path === '' ? [] : { content: Buffer.from(gemfile).toString('base64') },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), production ? {
      status: 'pending',
      reasons: '**Dependency updates:**\n- rack 3.1.0 -> 3.1.1',
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    } : { status: 'up-to-date' });
  });
});
