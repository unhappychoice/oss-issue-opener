import { scanBlockComments } from './block-comments.js';

export const swiftDependencies = (content: string): Set<string> => {
  const tokens = swiftTokens(content);
  return new Set(tokens.flatMap((token, index) =>
    token === '.' && tokens[index + 1] === 'package' && tokens[index + 2] === '('
      ? packageIdentifiers(tokens, index + 3) : []
  ));
};

const swiftTokens = (content: string): string[] => {
  const code = /\s+|\/\/[^\r\n]*|\/\*|"(?:\\.|[^"\\])*"|[A-Za-z_]\w*|[^\s]/gy;
  const tokens: string[] = [];
  scanBlockComments(content, code, (token, depth) => {
    if (depth === 0 && token !== '/*' && !/^\s|^\/\//.test(token)) tokens.push(token);
  });
  return tokens;
};

const packageIdentifiers = (tokens: string[], start: number): string[] => {
  const identifiers: string[] = [];
  let depth = 1;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '(') depth++;
    if (token === ')') depth--;
    if (depth === 0) break;
    if (depth !== 1 || !['name', 'url', 'path', 'id'].includes(token)) continue;
    const value = tokens[index + 2];
    if (tokens[index + 1] !== ':' || !/^"[^"\\]*"$/.test(value ?? '')) continue;
    if (![',', ')'].includes(tokens[index + 3])) continue;
    const literal = value.slice(1, -1);
    const identity = token === 'url' || token === 'path'
      ? literal.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/i, '') : literal;
    identifiers.push(identity.toLowerCase());
  }
  return identifiers;
};
