import { gemfileTokens } from './gemfile-tokens.js';
import { rubyDependencyName } from './ruby.js';

export const isProductionGem = (content: string, pkg: string): boolean =>
  productionGemNames(content).has(pkg);

export const productionGemNames = (content: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const blocks: string[][] = [];
  gemfileStatements(content).forEach((tokens) => {
    if (tokens[0] === 'end') blocks.pop();
    if (opensNamespace(tokens) || tokens.includes('do') || (tokens[0] === 'def' && !isEndlessMethod(tokens)) ||
      /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '') ||
      opensAssignedConditional(tokens)) {
      blocks.push(tokens[0] === 'group' ? groupTokens(tokens.slice(1)) : []);
    }
    if (tokens[0] !== 'gem') return;
    const nameIndex = tokens[1] === '(' ? 2 : 1;
    const name = rubyDependencyName(tokens[nameIndex]);
    if (name === undefined) return;
    const memberships = [...blocks.flat(), ...inlineGroupTokens(tokens.slice(nameIndex + 1))];
    if (memberships.length === 0 || memberships.some((token) => !isExcludedGroup(token))) names.add(name);
  });
  return names;
};

const opensAssignedConditional = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return depth === 0 && tokens[index - 1] === '=' && /^(if|unless)$/.test(token);
  });
};

const opensNamespace = (tokens: string[]): boolean => {
  if (isNamespaceKeyword(tokens[0])) return true;
  let depth = 0;
  return tokens.some((token, index) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return depth === 0 && token === '=' && isNamespaceKeyword(tokens[index + 1]);
  });
};

const isNamespaceKeyword = (token?: string): boolean => token === 'class' || token === 'module';

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};

const isExcludedGroup = (token: string): boolean =>
  /^(?::development|:test|['"]development['"]|['"]test['"])$/.test(token);

const groupTokens = (tokens: string[]): string[] => tokens.filter((token) => /^:\w+$|^['"]/.test(token));

const inlineGroupTokens = (tokens: string[]): string[] => {
  const index = tokens.findIndex((token, i) => {
    const label = /^(groups?|['"]groups?['"])$/.test(token) && tokens[i + 1] === ':';
    const hashKey = /^:groups?$/.test(token) && tokens[i + 1] === '=>';
    return label || hashKey;
  });
  if (index === -1) return [];
  const values = tokens.slice(index + 2);
  if (values[0] === '[') return groupTokens(values.slice(1, values.indexOf(']')));
  const valueLength = values[0] === ':' ? 2 : 1;
  return groupTokens(values.slice(0, valueLength));
};

const gemfileStatements = (content: string): string[][] => {
  const tokens = gemfileTokens(content);
  const result: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  tokens.forEach((token) => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) result.push(current);
      current = [];
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      result.push([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      if (current.length) result.push(current);
      result.push(['end']);
      current = [];
      return;
    }
    if (token === 'end' && depth === 0 && current.length) {
      result.push(current);
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if (token === 'do' && depth === 0) {
      result.push(current);
      current = [];
    }
  });
  if (current.length) result.push(current);
  return result;
};
