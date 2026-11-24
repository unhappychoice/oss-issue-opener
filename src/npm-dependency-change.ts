import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { getFileContent } from './github.js';

export const createNpmDependencyChangeChecker = (
  owner: string, repo: string, baseSha: string, headSha: string, paths: string[]
) => {
  const comparisons = new Map<string, Promise<(pkg: string) => boolean>>();
  return async (pkg: string, bumpPaths: string[]): Promise<{ changed: boolean; errors: unknown[] }> => {
    const relevant = paths.filter((path) => bumpPaths.includes(path));
    if (relevant.some((path) => otherNodeLockfile.test(path))) return { changed: true, errors: [] };
    const checks = relevant.filter((path) => npmFiles.has(path)).map((path) => {
      if (!comparisons.has(path)) {
        const load = (ref: string) => limitDownload(() => getFileContent(owner, repo, path, ref, true))
          .then(parseSnapshot);
        comparisons.set(path, Promise.all([load(baseSha), load(headSha)]).then(([base, head]) =>
          (pkg) => {
            const version = dependencyVersion(head, path, pkg);
            return typeof version === 'string' && version !== dependencyVersion(base, path, pkg);
          }
        ));
      }
      return comparisons.get(path)!;
    });
    const results = await Promise.allSettled(checks);
    return {
      changed: results.some((result) => result.status === 'fulfilled' && result.value(pkg)),
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
