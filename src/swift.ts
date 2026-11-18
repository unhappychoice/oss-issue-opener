export const swiftDependencies = (content: string): Set<string> => {
  const tokens = swiftTokens(content);
  return new Set(tokens.flatMap((token, index) =>
    token === '.' && tokens[index + 1] === 'package' && tokens[index + 2] === '('
      ? packageIdentifiers(tokens, index + 3) : []
  ));
};

const swiftTokens = (content: string): string[] => {
  const readToken = swiftTokenReader(content);
  const tokens: string[] = [];
  for (let index = 0; index < content.length;) {
    const token = readToken(index);
    index += token.length;
    if (!/^\s|^\/\/|^\/\*/.test(token)) tokens.push(token);
  }
  return tokens;
};

const swiftTokenReader = (content: string): ((index: number) => string) => {
  const code = /\s+|\/\/[^\r\n]*|\/\*|(#*)("""|")|[A-Za-z_]\w*|[^\s]/gy;
  const comment = /\/\*|\*\/|[^*/]+|[*/]/gy;

  const readToken = (index: number): string => {
    code.lastIndex = index;
    const [token, hashes, quotes] = code.exec(content)!;
    const start = code.lastIndex;
    if (token === '/*') return content.slice(index, blockCommentEnd(start));
    if (quotes === undefined) return token;
    const end = stringEnd(start, hashes, quotes);
    return end === undefined ? token : content.slice(index, end);
  };

  const blockCommentEnd = (start: number): number => {
    comment.lastIndex = start;
    let depth = 1;
    for (let match = comment.exec(content); match; match = comment.exec(content)) {
      if (match[0] === '/*') depth++;
      if (match[0] === '*/' && --depth === 0) return comment.lastIndex;
    }
    return content.length;
  };

  const stringEnd = (start: number, hashes: string, quotes: string): number | undefined => {
    const closing = quotes + hashes;
    const escape = '\\' + hashes;
    for (let index = start; index < content.length;) {
      if (content.startsWith(closing, index)) return index + closing.length;
      if (!content.startsWith(escape, index)) {
        index++;
        continue;
      }
      index += escape.length;
      index = content[index] === '(' ? interpolationEnd(index + 1) : index + 1;
    }
    return undefined;
  };

  const interpolationEnd = (start: number): number => {
    let depth = 1;
    for (let index = start; index < content.length;) {
      const token = readToken(index);
      index += token.length;
      if (token === '(') depth++;
      if (token === ')' && --depth === 0) return index;
    }
    return content.length;
  };

  return readToken;
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
    if (tokens[index + 1] !== ':') continue;
    const literal = staticStringValue(tokens[index + 2] ?? '');
    if (literal === undefined) continue;
    if (![',', ')'].includes(tokens[index + 3])) continue;
    const identity = token === 'url' || token === 'path'
      ? literal.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/i, '') : literal;
    identifiers.push(identity.toLowerCase());
  }
  return identifiers;
};

const staticStringValue = (token: string): string | undefined => {
  const match = /^(#*)"(?!"")(.*)"\1$/s.exec(token);
  if (!match) return undefined;
  const [, delimiter, value] = match;
  return value.includes('\\' + delimiter) ? undefined : value;
};
