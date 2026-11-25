import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { getFileContent } from './github.js';
import type { DependencyUpdate } from './types.js';

export const createNpmDependencyChangeChecker = (
  owner: string, repo: string, baseSha: string, headSha: string, paths: string[]
) => {
  const pathSet = new Set(paths);
  const comparisons = new Map<string, Promise<(bump: DependencyUpdate) => boolean>>();
  return async (bump: DependencyUpdate, bumpPaths: string[]): Promise<{ changed: boolean; errors: unknown[] }> => {
    const relevant = bumpPaths.filter((path) => pathSet.has(path));
    const npmPaths = relevant.filter((path) => npmFiles.has(path));
    if (npmPaths.length === 0) {
      return { changed: relevant.some((path) => otherNodeLockfile.test(path)), errors: [] };
    }
    const checks = npmPaths.map((path) => {
      if (!comparisons.has(path)) {
        const load = (ref: string) => limitDownload(() => getFileContent(owner, repo, path, ref, true))
          .then(parseSnapshot);
        comparisons.set(path, Promise.all([load(baseSha), load(headSha)]).then(([base, head]) =>
          ({ pkg, to }) => {
            const version = dependencyVersion(head, path, pkg);
            if (typeof version !== 'string' || version === dependencyVersion(base, path, pkg)) return false;
            return version === to || (path === 'package.json' && version.replace(/^[~^]/, '') === to);
          }
        ));
      }
      return comparisons.get(path)!;
    });
    const results = await Promise.allSettled(checks);
    return {
      changed: results.some((result) => result.status === 'fulfilled' && result.value(bump)),
      errors: results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : []),
    };
  };
};

const npmFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json']);
const otherNodeLockfile = /^(?:yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/;
const limitDownload = createConcurrencyLimiter(16);

const parseSnapshot = (content: string): unknown => content === '' ? undefined : JSON.parse(content);

const property = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;

const dependencyVersion = (snapshot: unknown, path: string, pkg: string): unknown => {
  const dependency = property(property(snapshot, 'dependencies'), pkg);
  if (path === 'package.json') return dependency;
  const packages = property(snapshot, 'packages');
  if (packages === undefined) return property(dependency, 'version');
  return property(property(packages, `node_modules/${pkg}`), 'version');
};
