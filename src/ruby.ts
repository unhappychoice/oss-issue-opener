import { gemfileTokens } from './gemfile-tokens.js';

export const rubyRuntimeDependencies = (content: string): string[] => {
  const tokens = gemfileTokens(content).filter((token) => !/^(?:[^\S\n]+|\\\r?\n|\n)$/.test(token));
  return tokens.flatMap((token, index) => {
    if (!/^(?:add_dependency|add_runtime_dependency)$/.test(token)) return [];
    const name = tokens[index + (tokens[index + 1] === '(' ? 2 : 1)] ?? '';
    return /^['"]/.test(name) ? [name.slice(1, -1)] : [];
  });
};
