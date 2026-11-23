import { gemfileScope, gemfileStatementReader } from './gemfile-statements.js';
import { gemfileTokens } from './gemfile-tokens.js';
import { rubyDependencyName } from './ruby.js';

export const isProductionGem = (content: string, pkg: string): boolean =>
  isProductionGemIn(gemfileStatements(content), pkg);

export const isProductionGemIn = (statements: string[][], pkg: string): boolean => {
  const blocks: boolean[] = [];
  let excludedScopes = 0;
  return statements.some((tokens) => {
    if (tokens[0] === 'end' && blocks.pop()) excludedScopes--;
    const excluded = excludedScopes > 0;
    if (gemfileScope(tokens)) {
      const excludesGroup = tokens[0] === 'group' && hasExcludedGroup(tokens.slice(1));
      blocks.push(excludesGroup);
      if (excludesGroup) excludedScopes++;
    }
    if (tokens[0] !== 'gem') return false;
    const nameIndex = tokens[1] === '(' ? 2 : 1;
    return rubyDependencyName(tokens[nameIndex]) === pkg && !excluded &&
      !hasInlineExcludedGroup(tokens.slice(nameIndex + 1));
  });
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

export const gemfileStatements = (content: string): string[][] => {
  const statements: string[][] = [];
  const reader = gemfileStatementReader((statement) => statements.push(statement));
  gemfileTokens(content).forEach(reader.push);
  reader.finish();
  return statements;
};
