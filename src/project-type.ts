import { getRepoContents } from './github.js';
import type { ProjectType } from './types.js';

const PROJECT_PATTERNS: { pattern: RegExp; type: ProjectType }[] = [
  { pattern: /^Cargo\.toml$/, type: 'rust' },
  { pattern: /^package\.json$/, type: 'node' },
  { pattern: /\.gemspec$/, type: 'ruby' },
  { pattern: /^Gemfile$/, type: 'ruby' },
  { pattern: /^build\.gradle(\.kts)?$/, type: 'kotlin' },
  { pattern: /^go\.mod$/, type: 'go' },
  { pattern: /^Package\.swift$/, type: 'swift' },
];

export const detectProjectTypes = async (owner: string, repo: string): Promise<ProjectType[]> => {
  const files = await getRepoContents(owner, repo);
  const types = PROJECT_PATTERNS
    .filter(({ pattern }) => files.some((f) => pattern.test(f)))
    .map(({ type }) => type);
  return types.length > 0 ? [...new Set(types)] : ['unknown'];
};

export const getSourcePatterns = (type: ProjectType): RegExp => {
  const patterns: Record<ProjectType, RegExp> = {
    ruby: /^lib\//,
    node: /^(src|lib)\//,
    rust: /^src\//,
    kotlin: /^(src|app\/src)\//,
    go: /\.go$/,
    swift: /^Sources\//,
    unknown: /^src\//,
  };
  return patterns[type];
};
