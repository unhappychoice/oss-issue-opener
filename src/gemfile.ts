import { gemfileTokens } from './gemfile-tokens.js';
import { rubyDependencyName } from './ruby.js';

export const isProductionGem = (content: string, pkg: string): boolean =>
  productionGemNames(content).has(pkg);

export const productionGemNames = (content: string): ReadonlySet<string> => {
  const names = new Set<string>();
  const blocks: { excludesGroup: boolean; scope: { localPuts: boolean } }[] = [];
  const rootScope = { localPuts: false };
  const currentScope = () => blocks.at(-1)?.scope ?? rootScope;
  let excludedScopes = 0;
  for (const tokens of gemfileStatements(gemfileTokens(content, currentScope))) {
    if (tokens[0] === 'end' && blocks.pop()?.excludesGroup) excludedScopes--;
    const excluded = excludedScopes > 0;
    const namespace = opensNamespace(tokens);
    const method = tokens[0] === 'def' && !isEndlessMethod(tokens);
    if (namespace || tokens.includes('do') || method ||
      /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) {
      const excludesGroup = tokens[0] === 'group' && hasExcludedGroup(tokens.slice(1));
      const scope = namespace || method
        ? { localPuts: method && hasPutsParameter(tokens) }
        : currentScope();
      blocks.push({ excludesGroup, scope });
      if (excludesGroup) excludedScopes++;
    }
    if (tokens[0] !== 'gem' || excluded) continue;
    const nameIndex = tokens[1] === '(' ? 2 : 1;
    const name = rubyDependencyName(tokens[nameIndex]);
    if (name !== undefined && !hasInlineExcludedGroup(tokens.slice(nameIndex + 1))) names.add(name);
  }
  return names;
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

const hasPutsParameter = (tokens: string[]): boolean => {
  const start = tokens[2] === '.' ? 4 : 2;
  const parenthesized = tokens[start] === '(';
  const parameterDepth = parenthesized ? 1 : 0;
  let depth = parameterDepth;
  let startsParameter = true;
  return tokens.slice(start + Number(parenthesized)).some((token) => {
    if (depth < parameterDepth) return false;
    if (depth === parameterDepth && token === 'puts' && startsParameter) return true;
    if (depth === parameterDepth && token !== '*' && token !== '&') startsParameter = token === ',';
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return false;
  });
};

function* gemfileStatements(tokens: Iterable<string>): Generator<string[]> {
  let current: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) continue;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) yield current;
      current = [];
      continue;
    }
    if (token === '\n') continue;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      yield [...current, 'do'];
      current = [];
      continue;
    }
    if (depth === 0 && token === '}') {
      if (current.length) yield current;
      yield ['end'];
      current = [];
      continue;
    }
    if (token === 'end' && depth === 0 && current.length) {
      yield current;
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      yield current;
      current = [];
    }
  }
  if (current.length) yield current;
}
