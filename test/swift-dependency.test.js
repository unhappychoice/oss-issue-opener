import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { createDependencyChecker } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');
afterEach(() => mock.restoreAll());

const manifest = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "App",
  dependencies: [.package(url: "https://github.com/apple/swift-argument-parser", from: "1.0.0")],
  targets: [.target(name: "App")]
)
// swift-log was removed from dependencies
`;

const stubManifest = (content) => mock.method(getOctokit().repos, 'getContent', async ({ path }) => {
  assert.equal(path, 'Package.swift');
  return { data: { content: Buffer.from(content).toString('base64') } };
});

test('Swift matches declared package identities instead of comments, targets or substrings', async () => {
  const request = stubManifest(manifest);
  const check = createDependencyChecker('owner', 'repo', 'swift');
  for (const [pkg, expected] of [
    ['swift-log', false], ['argument', false], ['App', false],
    ['swift-argument-parser', true], ['apple', false], ['swift-argument', false],
  ]) assert.equal(await check(pkg), expected, pkg);
  assert.equal(request.mock.calls.length, 1);
});

const cases = [
  ['Git URL suffix', '.package(url: "https://github.com/apple/swift-log.git", from: "1.0.0")', 'swift-log', true],
  ['extended Git URL', '.package(url: #"https://github.com/apple/swift-log.git"#, from: "1.0.0")', 'swift-log', true],
  ['multiple extended delimiters', '.package(url: ##"https://example.com/"#/Swift-Log.git/"##)', 'swift-log', true],
  ['inactive escape in extended URL', String.raw`.package(url: ##"https://example.com/\#(literal)/swift-log.git"##)`, 'swift-log', true],
  ['interpolated extended URL', String.raw`.package(url: #"https://example.com/\#(host)/swift-log.git"#)`, 'swift-log', false],
  ['escaped quote in extended URL', String.raw`.package(url: #"https://example.com/\#"#/swift-log.git"#)`, 'swift-log', false],
  ['extended string containing declaration', 'let text = #".package(url: "swift-log")"#', 'swift-log', false],
  ['declaration inside interpolation', String.raw`let text = #"\#(render(/* ) /* ( */ */ .package(url: #"swift-log"#)))"#`, 'swift-log', false],
  ['multiline string inside interpolation', String.raw`let text = #"\#("""
    .package(url: "swift-log")
    """)"#`, 'swift-log', false],
  ['extended string expression', '.package(url: #"swift-log"# + "-extra")', 'swift-log', false],
  ['SSH URL', '.package(url: "git@github.com:apple/swift-log.git", branch: "main")', 'swift-log', true],
  ['trailing slash and case', '.package(url: "https://github.com/apple/Swift-Log.git/", from: "1.0.0")', 'swift-log', true],
  ['explicit name', '.package(name: "Logging", url: "https://github.com/apple/swift-log", from: "1.0.0")', 'Logging', true],
  ['local path', '.package(path: "../swift-log")', 'swift-log', true],
  ['registry identity', '.package(id: "apple.swift-log", from: "1.0.0")', 'apple.swift-log', true],
  ['multiline declaration', '.package \n(\nurl: "https://github.com/apple/swift-log",\n .upToNextMajor(from: "1.0.0")\n)', 'swift-log', true],
  ['line comment', '// .package(url: "swift-log")\n.package(url: "other")', 'swift-log', false],
  ['nested block comments', '/* /* nested */ // ignored */ /* .package(url: "swift-log") */ .package(url: "other")', 'swift-log', false],
  ['inline comment', '.package(/* url: "swift-log" */ url: "other")', 'swift-log', false],
  ['comments between arguments', '.package(/* nested /* comment */ */ url: /* comment */ "swift-log", from: "1")', 'swift-log', true],
  ['target name', '.package(url: "other"), .target(name: "swift-log")', 'swift-log', false],
  ['branch name', '.package(url: "other", branch: "swift-log")', 'swift-log', false],
  ['nested argument', '.package(url: makeURL(name: "swift-log"))', 'swift-log', false],
  ['string expression', '.package(url: "swift-log" + "-extra")', 'swift-log', false],
  ['string containing declaration', 'let text = ".package(url: \\"swift-log\\")"', 'swift-log', false],
  ['empty manifest', '', 'swift-log', false],
];

const interpolatedManifest = String.raw`
let label = #"\#(#"nested"#)"#
let package = Package(dependencies: [
  .package(url: "https://example.com/swift-nio.git", from: "1.1.0"),
])
`;

cases.forEach(([name, content, pkg, expected]) => {
  test(`Swift production dependency: ${name}`, async () => {
    stubManifest(content);
    assert.equal(await createDependencyChecker('owner', 'repo', 'swift')(pkg), expected);
  });
});

[
  ['swift-log', manifest, 'Package.resolved', false],
  ['argument', manifest, 'Package.resolved', false],
  ['swift-argument-parser', manifest, 'Package.resolved', true],
  ['swift-log', '.package(url: #"https://example.com/swift-log.git"#, from: "1.1.0")', 'Package.swift', true],
  ['swift-nio', interpolatedManifest, 'Package.resolved', true],
].forEach(([pkg, content, filename, pending]) => {
  test(`Swift release check with ${filename} change and ${pkg} bump`, async () => {
    stubManifest(content);
    const repos = getOctokit().repos;
    mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1.0.0' }] }));
    mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename }],
      commits: [{ commit: { message: `Bump ${pkg} from 1.0.0 to 1.1.0` } }],
    } }));
    const result = await checkPendingRelease('owner', 'repo', 'swift');
    assert.deepEqual(result, pending ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg, from: '1.0.0', to: '1.1.0' }],
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    } : { status: 'up-to-date' });
  });
});
