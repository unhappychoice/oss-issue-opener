import { getRepoContents } from './github.js';
import type { ProjectType } from './types.js';

const PROJECT_PATTERNS: { pattern: RegExp; lockfile: RegExp; type: ProjectType }[] = [
  { pattern: /^Cargo\.toml$/, lockfile: /^Cargo\.lock$/, type: 'rust' },
  {
    pattern: /^package\.json$/,
    lockfile: /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
    type: 'node',
  },
  { pattern: /^(?:[^/]+\.gemspec|Gemfile)$/, lockfile: /^Gemfile\.lock$/, type: 'ruby' },
  { pattern: /^build\.gradle(\.kts)?$/, lockfile: /^(?:gradle\.lockfile|gradle\/libs\.versions\.toml)$/, type: 'kotlin' },
  { pattern: /^go\.mod$/, lockfile: /^go\.sum$/, type: 'go' },
  { pattern: /^Package\.swift$/, lockfile: /^Package\.resolved$/, type: 'swift' },
];

export const detectProjectTypes = async (
  owner: string,
  repo: string,
  getContents: () => Promise<string[]> = () => getRepoContents(owner, repo)
): Promise<ProjectType[]> => {
  const files = await getContents();
  const types = PROJECT_PATTERNS
    .filter(({ pattern }) => files.some((f) => pattern.test(f)))
    .map(({ type }) => type);
  return types.length > 0 ? types : ['unknown'];
};

export const getDependencyProjectTypes = (paths: string[]): ProjectType[] =>
  PROJECT_PATTERNS.filter(({ pattern, lockfile }) =>
    paths.some((path) => pattern.test(path) || lockfile.test(path))
  ).map(({ type }) => type);

export const getSourcePatterns = (type: ProjectType): RegExp => {
  const patterns: Record<ProjectType, RegExp> = {
    ruby: /^lib\//,
    node: /^(src|lib)\//,
    rust: /^src\//,
    kotlin: /^(src|app\/src)\//,
    go: /^(?!vendor\/).*(?<!_test)\.go$/,
    swift: /^Sources\//,
    unknown: /^src\//,
  };
  return patterns[type];
};
