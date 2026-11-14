import { getFileContent, getRepoContents } from './github.js';
import { parse } from 'smol-toml';
import type { ProjectType } from './types.js';
import { isProductionGem } from './gemfile.js';
import { rubyRuntimeDependencies } from './ruby.js';
import { swiftDependencies } from './swift.js';
import { gradleDependencies } from './gradle.js';

type DependencyChecker = (pkg: string) => Promise<boolean>;
type DependencyLoader = (
  file: (path: string) => Promise<string>,
  contents: () => Promise<string[]>
) => Promise<DependencyChecker>;

export const createDependencyChecker = (
  owner: string,
  repo: string,
  type: ProjectType | ProjectType[]
): DependencyChecker => {
  const files = new Map<string, Promise<string>>();
  const file = (path: string): Promise<string> => {
    if (!files.has(path)) files.set(path, getFileContent(owner, repo, path));
    return files.get(path)!;
  };
  const types = Array.isArray(type) ? type : [type];
  let checkers: Promise<DependencyChecker[]> | undefined;
  return async (pkg) => {
    checkers ??= Promise.all(types.map((type) =>
      loaders[type](file, () => getRepoContents(owner, repo))
    ));
    const results = await Promise.all((await checkers).map((check) => check(pkg)));
    return results.some(Boolean);
  };
};

export const isProductionDependency = (
  owner: string,
  repo: string,
  pkg: string,
  type: ProjectType | ProjectType[]
): Promise<boolean> => createDependencyChecker(owner, repo, type)(pkg);

const loadRuby: DependencyLoader = async (file, contents) => {
  const gemspecNames = (await contents()).filter((name) => name.endsWith('.gemspec'));
  const dependencies = new Set((await Promise.all(gemspecNames.map(file))).flatMap(rubyRuntimeDependencies));
  return async (pkg) => {
    if (dependencies.has(pkg)) return true;
    const gemfile = await file('Gemfile');
    return isProductionGem(gemfile, pkg);
  };
};

const loadNode: DependencyLoader = async (file) => {
  try {
    const json = JSON.parse(await file('package.json'));
    const dependencies = json.dependencies ?? {};
    return async (pkg) => typeof dependencies === 'object' && Object.hasOwn(dependencies, pkg);
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
    const packages = new Set(dependencies.flatMap((table) =>
      Object.entries(table).map(([name, declaration]) => asTable(declaration).package ?? name)
    ));
    return async (pkg) => packages.has(pkg);
  } catch {
    return async () => false;
  }
};

const loadKotlin: DependencyLoader = async (file) => {
  const content = await file('build.gradle') || await file('build.gradle.kts');
  const coordinates = gradleDependencies(content);
  return async (pkg) => coordinates.some((coordinate) =>
    coordinate === pkg || coordinate.startsWith(`${pkg}:`)
  );
};

const loadGo: DependencyLoader = async (file) => {
  const content = await file('go.mod');
  let block = '';
  const modules = content.split(/\r?\n/).flatMap((line) => {
    const declaration = line.replace(/\/\/.*$/, '').trim();
    if (declaration === ')') { block = ''; return []; }
    const opening = declaration.match(/^(\w+)\s*\($/);
    if (opening) { block = opening[1]; return []; }
    const requirement = block === 'require' ? declaration :
      block === '' ? declaration.match(/^require\s+(.+)$/)?.[1] ?? '' : '';
    const module = requirement.match(/^(?:"([^"]+)"|([^\s"]+))\s+\S+$/);
    return module ? [module[1] ?? module[2]] : [];
  });
  return async (pkg) => modules.includes(pkg);
};

const loadSwift: DependencyLoader = async (file) => {
  const dependencies = swiftDependencies(await file('Package.swift'));
  return async (pkg) => dependencies.has(pkg.toLowerCase());
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
