import { gemfileStatements, opensBlock } from './gemfile-scopes.js';
import { gemfileTokens } from './gemfile-tokens.js';
import { rubyDependencyName } from './ruby.js';

export const isProductionGem = (content: string, pkg: string): boolean =>
  productionGemNames(content).has(pkg);

export const productionGemNames = (content: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const blocks: boolean[] = [];
  let excludedScopes = 0;
  gemfileStatements(gemfileTokens(content)).forEach((tokens) => {
    if (tokens[0] === 'end' && blocks.pop()) excludedScopes--;
    const excluded = excludedScopes > 0;
    if (opensBlock(tokens)) {
      const excludesGroup = tokens[0] === 'group' && hasExcludedGroup(tokens.slice(1));
      blocks.push(excludesGroup);
      if (excludesGroup) excludedScopes++;
    }
    if (tokens[0] !== 'gem' || excluded) return;
    const nameIndex = tokens[1] === '(' ? 2 : 1;
    const name = rubyDependencyName(tokens[nameIndex]);
    if (name !== undefined && !hasInlineExcludedGroup(tokens.slice(nameIndex + 1))) names.add(name);
  });
  return names;
};

const hasExcludedGroup = (tokens: string[]): boolean => {
  const groups = tokens.filter((token) => /^:\w+$|^['"]/.test(token));
  return groups.length > 0 && groups.every((token) =>
    /^(?::development|:test|['"]development['"]|['"]test['"])$/.test(token));
};

const hasInlineExcludedGroup = (tokens: string[]): boolean => tokens.some((token, index) => {
  const label = /^(groups?|['"]groups?['"])$/.test(token) && tokens[index + 1] === ':';
  const hashKey = /^:groups?$/.test(token) && tokens[index + 1] === '=>';
  if (!label && !hashKey) return false;
  const values = tokens.slice(index + 2);
  if (values[0] === '[') return hasExcludedGroup(values.slice(1, values.indexOf(']')));
  const valueLength = values[0] === ':' ? 2 : 1;
  return hasExcludedGroup(values.slice(0, valueLength));
});
