import { getFileContent, getRepoContents } from './github.js';
import { parse } from 'smol-toml';
import type { ProjectType } from './types.js';

type DependencyChecker = (pkg: string) => Promise<boolean>;
type DependencyLoader = (
  file: (path: string) => Promise<string>,
  contents: () => Promise<string[]>
) => Promise<DependencyChecker>;

export const createDependencyChecker = (
  owner: string,
  repo: string,
  type: ProjectType
): DependencyChecker => {
  const files = new Map<string, Promise<string>>();
  const file = (path: string): Promise<string> => {
    if (!files.has(path)) files.set(path, getFileContent(owner, repo, path));
    return files.get(path)!;
  };
  let checker: Promise<DependencyChecker> | undefined;
  return async (pkg) => {
    checker ??= loaders[type](file, () => getRepoContents(owner, repo));
    return (await checker)(pkg);
  };
};

export const isProductionDependency = (
  owner: string,
  repo: string,
  pkg: string,
  type: ProjectType
): Promise<boolean> => createDependencyChecker(owner, repo, type)(pkg);

const loadRuby: DependencyLoader = async (file, contents) => {
  const gemspecName = (await contents()).find((name) => name.endsWith('.gemspec'));
  const gemspec = gemspecName ? await file(gemspecName) : '';
  return async (pkg) => {
    if (new RegExp(`add_dependency.*['"]${pkg}['"]`).test(gemspec)) return true;
    const gemfile = await file('Gemfile');
    return new RegExp(`^gem ['"]${pkg}['"]`, 'm').test(gemfile) &&
      !/:development|:test/.test(gemfile.split(pkg)[0]?.split('\n').pop() ?? '');
  };
};

const loadNode: DependencyLoader = async (file) => {
  try {
    const json = JSON.parse(await file('package.json'));
    const dependencies = json.dependencies ?? {};
    return async (pkg) => typeof dependencies === 'object' && pkg in dependencies;
  } catch {
    return async () => false;
  }
};

const asTable = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const loadRust: DependencyLoader = async (file) => {
  const content = await file('Cargo.toml');
  try {
    const manifest = parse(content);
    const tables = [manifest, ...Object.values(asTable(manifest.target))];
    const dependencies = tables.map((table) => asTable(asTable(table).dependencies));
    return async (pkg) => dependencies.some((table) => Object.hasOwn(table, pkg));
  } catch {
    return async () => false;
  }
};

const loadKotlin: DependencyLoader = async (file) => {
  const content = await file('build.gradle') || await file('build.gradle.kts');
  const hasProductionDependencies = /(implementation|api)\s*[("']/.test(content);
  return async (pkg) => hasProductionDependencies && content.includes(pkg);
};

const loadGo: DependencyLoader = async (file) => {
  const content = await file('go.mod');
  return async (pkg) => content.includes(pkg);
};

const loadSwift: DependencyLoader = async (file) => {
  const content = await file('Package.swift');
  const hasPackages = /\.package\(/.test(content);
  return async (pkg) => hasPackages && content.includes(pkg);
};

const loaders: Record<ProjectType, DependencyLoader> = {
  ruby: loadRuby,
  node: loadNode,
  rust: loadRust,
  kotlin: loadKotlin,
  go: loadGo,
  swift: loadSwift,
  unknown: async () => async () => true,
};
