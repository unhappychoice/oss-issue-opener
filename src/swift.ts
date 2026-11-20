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

type StringFrame = { opening: number; start: number; closing: string; escape: string };

const stringFrame = (opening: number, start: number, hashes: string, quotes: string): StringFrame => ({
  opening, start, closing: quotes + hashes, escape: '\\' + hashes,
});

const swiftTokenReader = (content: string): ((index: number) => string) => {
  const code = /\s+|\/\/[^\r\n]*|\/\*|(#*)("""|")|[A-Za-z_]\w*|[^\s]/gy;
  const comment = /\/\*|\*\/|[^*/]+|[*/]/gy;

  const unterminated = new Set<number>();

  const readToken = (index: number): string => {
    code.lastIndex = index;
    const [token, hashes, quotes] = code.exec(content)!;
    const start = code.lastIndex;
    if (token === '/*') return content.slice(index, blockCommentEnd(start));
    if (quotes === undefined || unterminated.has(index)) return token;
    const end = stringEnd(stringFrame(index, start, hashes, quotes));
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

  const stringEnd = (opening: StringFrame): number | undefined => {
    const stack: (StringFrame | number)[] = [opening];
    let index = opening.start;
    while (stack.length > 0) {
      const top = stack.length - 1;
      const frame = stack[top];
      if (index >= content.length) {
        stack.pop();
        if (typeof frame === 'number') continue;
        // An unterminated string contributes only its opening delimiter as a token.
        unterminated.add(frame.opening);
        index = frame.start;
      } else if (typeof frame === 'number') {
        const tokenStart = index;
        code.lastIndex = tokenStart;
        const [token, hashes, quotes] = code.exec(content)!;
        index = code.lastIndex;
        if (token === '/*') index = blockCommentEnd(index);
        if (token === '(') stack[top] = frame + 1;
        if (token === ')') {
          if (frame === 1) stack.pop();
          else stack[top] = frame - 1;
        }
        if (quotes !== undefined && !unterminated.has(tokenStart)) {
          stack.push(stringFrame(tokenStart, index, hashes, quotes));
        }
      } else if (content.startsWith(frame.closing, index)) {
        index += frame.closing.length;
        stack.pop();
        if (stack.length === 0) return index;
      } else if (content.startsWith(frame.escape, index)) {
        index += frame.escape.length;
        if (content[index] === '(') stack.push(1);
        index++;
      } else {
        index++;
      }
    }
    return undefined;
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
