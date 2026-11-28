import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { getFileContent, getRepoContents } from './github.js';
import { parse } from 'smol-toml';
import type { ProjectType } from './types.js';
import { productionGemNames } from './gemfile.js';
import { rubyRuntimeDependencies } from './ruby.js';
import { swiftDependencies } from './swift.js';
import { parseGradleDependencies } from './gradle.js';
import { createNodeManifestLoader } from './npm-dependency-change.js';

type DependencyChecker = (pkg: string) => Promise<boolean>;
type ReadManifest = (path: string, optional?: boolean) => Promise<string>;
type DependencyLoader = (
  file: ReadManifest,
  contents: () => Promise<string[]>
) => Promise<DependencyChecker>;

export const createDependencyChecker = (
  owner: string,
  repo: string,
  type: ProjectType | ProjectType[],
  getContents?: () => Promise<string[]>,
  ref?: string,
  loadManifest = createNodeManifestLoader(owner, repo, ref)
): DependencyChecker => {
  const files = new Map<string, Promise<string>>();
  const file: ReadManifest = (path, optional) => {
    if (!files.has(path)) {
      const download = () => getFileContent(owner, repo, path, ref, optional);
      files.set(path, path.endsWith('.gemspec') ? limitGemspecDownload(download) : download());
    }
    return files.get(path)!;
  };
  const types = Array.isArray(type) ? type : [type];
  let checkers: Promise<DependencyChecker[]> | undefined;
  return async (pkg) => {
    checkers ??= Promise.all(types.map((type) => type === 'node' ? loadNode(loadManifest) : loaders[type](file,
      getContents ?? (async () => type === 'ruby' ? getRepoContents(owner, repo, '', ref) : [])
    )));
    const results = await Promise.all((await checkers).map((check) => check(pkg)));
    return results.some(Boolean);
  };
};

export const isProductionDependency = (
  owner: string,
  repo: string,
  pkg: string,
  type: ProjectType | ProjectType[],
  getContents?: () => Promise<string[]>
): Promise<boolean> => createDependencyChecker(owner, repo, type, getContents)(pkg);

const limitGemspecDownload = createConcurrencyLimiter(8);

const loadRuby: DependencyLoader = async (file, contents) => {
  const names = await contents();
  const hasGemfile = names.includes('Gemfile');
  const gemspecNames = names.filter((name) => name.endsWith('.gemspec'));
  const dependencies = new Set((await Promise.all(gemspecNames.map((name) => file(name)))).flatMap(rubyRuntimeDependencies));
  let gemfileDependencies: Promise<ReadonlySet<string>> | undefined;
  return async (pkg) => {
    if (dependencies.has(pkg)) return true;
    if (!hasGemfile) return false;
    gemfileDependencies ??= file('Gemfile').then(productionGemNames);
    return (await gemfileDependencies).has(pkg);
  };
};

const loadNode = async (loadManifest: ReturnType<typeof createNodeManifestLoader>): Promise<DependencyChecker> => {
  const manifest = await loadManifest();
  const dependencies = 'snapshot' in manifest ? asTable(manifest.snapshot).dependencies ?? {} : {};
  return async (pkg) => typeof dependencies === 'object' && Object.hasOwn(dependencies, pkg);
};

const asTable = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const loadRust: DependencyLoader = async (file) => {
  const content = await file('Cargo.toml');
  try {
    const manifest = parse(content);
    const workspaceDependencies = asTable(asTable(manifest.workspace).dependencies);
    const tables = [manifest, ...Object.values(asTable(manifest.target))];
    const dependencies = tables.map((table) => asTable(asTable(table).dependencies));
    const packages = new Set(dependencies.flatMap((table) =>
      Object.entries(table).map(([name, declaration]) => {
        const dependency = asTable(declaration);
        const resolved = dependency.workspace === true ? asTable(workspaceDependencies[name]) : dependency;
        return resolved.package ?? name;
      })
    ));
    return async (pkg) => packages.has(pkg);
  } catch {
    return async () => false;
  }
};

const loadKotlin: DependencyLoader = async (file, contents) => {
  const files = await contents();
  const hasGroovy = files.includes('build.gradle');
  const hasKotlin = files.includes('build.gradle.kts');
  const groovy = hasKotlin && !hasGroovy ? '' : await file('build.gradle', !hasGroovy);
  const content = groovy || await file('build.gradle.kts', !hasKotlin);
  const { coordinates, aliases } = parseGradleDependencies(content);
  if (aliases.length > 0) {
    const catalog = await file('gradle/libs.versions.toml', true);
    coordinates.push(...gradleCatalogCoordinates(catalog, aliases));
  }
  return async (pkg) => coordinates.some((coordinate) =>
    coordinate === pkg || coordinate.startsWith(`${pkg}:`)
  );
};

const gradleAccessor = (alias: string): string => alias.replace(/[-_]/g, '.');

const gradleCatalogCoordinates = (content: string, aliases: string[]): string[] => {
  try {
    const catalog = parse(content);
    const bundles = new Map<string, unknown>(Object.entries(asTable(catalog.bundles)).map(([alias, members]) =>
      [`bundles.${gradleAccessor(alias)}`, members]
    ));
    const libraries = new Set(aliases.flatMap((alias) => {
      if (!alias.startsWith('bundles.')) return [alias];
      const members = bundles.get(alias);
      return Array.isArray(members) ? members.filter((member) => typeof member === 'string').map(gradleAccessor) : [];
    }));
    return Object.entries(asTable(catalog.libraries)).flatMap(([alias, value]) => {
      if (!libraries.has(gradleAccessor(alias))) return [];
      if (typeof value === 'string') return [value];
      const { module, group, name } = asTable(value);
      if (typeof module === 'string') return [module];
      return typeof group === 'string' && typeof name === 'string' ? [`${group}:${name}`] : [];
    });
  } catch {
    return [];
  }
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

const loaders: Record<Exclude<ProjectType, 'node'>, DependencyLoader> = {
  ruby: loadRuby,
  rust: loadRust,
  kotlin: loadKotlin,
  go: loadGo,
  swift: loadSwift,
  unknown: async () => async () => false,
};
