import { getRepoContents } from './github.js';
import type { ProjectType } from './types.js';

const PROJECT_PATTERNS: { pattern: RegExp; type: ProjectType }[] = [
  { pattern: /^Cargo\.toml$/, type: 'rust' },
  { pattern: /^package\.json$/, type: 'node' },
  { pattern: /\.gemspec$/, type: 'ruby' },
  { pattern: /^build\.gradle(\.kts)?$/, type: 'kotlin' },
  { pattern: /^go\.mod$/, type: 'go' },
  { pattern: /^Package\.swift$/, type: 'swift' },
];

export const detectProjectType = async (owner: string, repo: string): Promise<ProjectType> => {
  const files = await getRepoContents(owner, repo);
  return (
    PROJECT_PATTERNS.find(({ pattern }) => files.some((f) => pattern.test(f)))?.type ?? 'unknown'
  );
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
