import { gemfileTokens } from './gemfile-tokens.js';

export const rubyDependencyName = (token = ''): string | undefined =>
  /^(['"])[\s\S]*\1$/.test(token) ? token.slice(1, -1) : undefined;

export const rubyRuntimeDependencies = (content: string): string[] => {
  const tokens = gemfileTokens(content).filter((token) => !/^(?:[^\S\n]+|\\\r?\n|\n)$/.test(token));
  return tokens.flatMap((token, index) => {
    if (!/^(?:add_dependency|add_runtime_dependency)$/.test(token)) return [];
    const name = rubyDependencyName(tokens[index + (tokens[index + 1] === '(' ? 2 : 1)]);
    return name === undefined ? [] : [name];
  });
};
