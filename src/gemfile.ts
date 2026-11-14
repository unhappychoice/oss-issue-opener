import { stripRubyComments } from './ruby.js';

export const isProductionGem = (content: string, pkg: string): boolean => {
  const blocks: boolean[] = [];
  return statements(content).some((tokens) => {
    if (tokens[0] === 'end') blocks.pop();
    const excluded = blocks.includes(true);
    if (tokens.includes('do') || /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) {
      blocks.push(tokens[0] === 'group' && hasExcludedGroup(tokens.slice(1)));
    }
    if (tokens[0] !== 'gem') return false;
    const nameIndex = tokens[1] === '(' ? 2 : 1;
    return unquote(tokens[nameIndex] ?? '') === pkg && !excluded &&
      !hasInlineExcludedGroup(tokens.slice(nameIndex + 1));
  });
};

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, '');

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
  return hasExcludedGroup(values[0] === '[' ? values.slice(1, values.indexOf(']')) : values.slice(0, 1));
});

const statements = (content: string): string[][] => {
  const tokens = stripRubyComments(content).match(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\\\r?\n|:\w+|\w+[!?]?|=>|[^\S\n]+|\n|./g) ?? [];
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
    if ((token === 'do' || token === 'end') && depth === 0) {
      result.push(current);
      current = [];
    }
  });
  if (current.length) result.push(current);
  return result;
};
