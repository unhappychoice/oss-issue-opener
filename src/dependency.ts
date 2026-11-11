import { getFileContent, getRepoContents } from './github.js';
import { parse } from 'smol-toml';
import type { ProjectType } from './types.js';
import { isProductionGem } from './gemfile.js';

type DependencyChecker = (owner: string, repo: string, pkg: string) => Promise<boolean>;

const checkRubyDependency: DependencyChecker = async (owner, repo, pkg) => {
  const files = await getRepoContents(owner, repo);
  const gemspecName = files.find((f) => f.endsWith('.gemspec'));

  if (gemspecName) {
    const gemspec = await getFileContent(owner, repo, gemspecName);
    if (new RegExp(`add_dependency.*['"]${pkg}['"]`).test(gemspec)) return true;
  }

  const gemfile = await getFileContent(owner, repo, 'Gemfile');
  return isProductionGem(gemfile, pkg);
};

const checkNodeDependency: DependencyChecker = async (owner, repo, pkg) => {
  const content = await getFileContent(owner, repo, 'package.json');
  if (!content) return false;
  try {
    const json = JSON.parse(content);
    return pkg in (json.dependencies ?? {});
  } catch {
    return false;
  }
};

const asTable = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const checkRustDependency: DependencyChecker = async (owner, repo, pkg) => {
  const content = await getFileContent(owner, repo, 'Cargo.toml');
  try {
    const manifest = parse(content);
    const tables = [manifest, ...Object.values(asTable(manifest.target))];
    return tables.some((table) => Object.hasOwn(asTable(asTable(table).dependencies), pkg));
  } catch {
    return false;
  }
};

const checkKotlinDependency: DependencyChecker = async (owner, repo, pkg) => {
  let content = await getFileContent(owner, repo, 'build.gradle');
  if (!content) content = await getFileContent(owner, repo, 'build.gradle.kts');
  const declarations = content.matchAll(/^\s*(?:implementation|api)\s*(?:\(\s*)?(['"])([^'"\r\n]+)\1/gm);
  return Array.from(declarations).some(([, , coordinate]) =>
    coordinate === pkg || coordinate.startsWith(`${pkg}:`)
  );
};

const checkGoDependency: DependencyChecker = async (owner, repo, pkg) => {
  const content = await getFileContent(owner, repo, 'go.mod');
  return content.includes(pkg);
};

const checkSwiftDependency: DependencyChecker = async (owner, repo, pkg) => {
  const content = await getFileContent(owner, repo, 'Package.swift');
  return /\.package\(/.test(content) && content.includes(pkg);
};

const checkers: Record<ProjectType, DependencyChecker> = {
  ruby: checkRubyDependency,
  node: checkNodeDependency,
  rust: checkRustDependency,
  kotlin: checkKotlinDependency,
  go: checkGoDependency,
  swift: checkSwiftDependency,
  unknown: async () => true,
};

export const isProductionDependency = (
  owner: string,
  repo: string,
  pkg: string,
  type: ProjectType
): Promise<boolean> => checkers[type](owner, repo, pkg);
