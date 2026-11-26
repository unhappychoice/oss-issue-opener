import { blockCommentEnd } from './block-comments.js';

export const swiftDependencies = (content: string): Set<string> =>
  packageIdentifiers(swiftTokens(content));

export const packageIdentifiers = (tokens: readonly string[]): Set<string> => {
  const calls: string[][] = [];
  const active: { depth: number; identifiers: string[] }[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '(') {
      depth++;
      if (tokens[index - 2] === '.' && tokens[index - 1] === 'package') {
        const identifiers: string[] = [];
        calls.push(identifiers);
        active.push({ depth, identifiers });
      }
      continue;
    }
    const call = active.at(-1);
    if (token === ')') {
      if (call?.depth === depth) active.pop();
      depth--;
    } else if (call?.depth === depth) {
      const identifier = packageIdentifier(tokens, index, token);
      if (identifier !== undefined) call.identifiers.push(identifier);
    }
  }
  // Keep identifiers in call-opening order, even when a nested call closes first.
  return new Set(calls.flat());
};

const swiftTokens = (content: string): string[] => {
  const readToken = swiftTokenReader(content);
  const tokens: string[] = [];
  for (let index = 0; index < content.length;) {
    const token = readToken(index, tokens.at(-1));
    index += token.length;
    if (!/^\s|^\/\/|^\/\*/.test(token)) tokens.push(token);
  }
  return tokens;
};

type StringFrame = { opening: number; start: number; closing: string; escape: string };
type InterpolationFrame = { depth: number; previous?: string };
type ClosingIndex = { positions: Map<number, number[]>; newlines: number[] };

// Indexes every unescaped `/` + hashes closer and line break once per manifest, grouped by
// hash count, so regexEnd can binary-search instead of rescanning the suffix for each opener.
const buildClosingIndex = (content: string): ClosingIndex => {
  const positions = new Map<number, number[]>();
  const newlines: number[] = [];
  let backslashRun = 0;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === '\\') { backslashRun++; continue; }
    if (char === '/' && backslashRun % 2 === 0) {
      let end = index + 1;
      while (content[end] === '#') end++;
      if (end > index + 1) {
        const hashCount = end - index - 1;
        const list = positions.get(hashCount);
        if (list) list.push(index); else positions.set(hashCount, [index]);
        index = end - 1;
        backslashRun = 0;
        continue;
      }
    }
    if (char === '\r' || char === '\n') newlines.push(index);
    backslashRun = 0;
  }
  return { positions, newlines };
};

const atOrAfter = (sorted: readonly number[], value: number): number | undefined => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] < value) low = mid + 1; else high = mid;
  }
  return low < sorted.length ? sorted[low] : undefined;
};

const startsExpression = (previous: string | undefined): boolean =>
  previous === undefined || /^(?:[([{,:;=!?&|+*%~<>^-]|if|in|return|throw|case|try|await|yield)$/.test(previous);

const stringFrame = (opening: number, start: number, hashes: string, quotes: string): StringFrame => ({
  opening, start, closing: quotes + hashes, escape: '\\' + hashes,
});

const swiftTokenReader = (content: string): ((index: number, previous: string | undefined) => string) => {
  const code = /\s+|\/\/[^\r\n]*|\/\*|(#+)(?:("""|")|(\/))?|("""|")|[A-Za-z_]\w*|[^\s]/gy;
  const multilineRegexStart = /[ \t]*[\r\n]/y;
  const bareRegexPart = /\\[^\r\n]|[^\\\/()[\]\r\n]+|[()[\]\/]/y;

  const unterminated = new Set<number>();
  let closingIndex: ClosingIndex | undefined;

  const readToken = (index: number, previous: string | undefined): string => {
    code.lastIndex = index;
    const [token, hashes, extendedQuotes, regexSlash, plainQuotes] = code.exec(content)!;
    const start = code.lastIndex;
    if (token === '/*') return content.slice(index, blockCommentEnd(content, start));
    if (regexSlash !== undefined) return content.slice(index, regexEnd(start, hashes.length));
    if (token === '/') return content.slice(index, bareRegexEnd(start, previous));
    const quotes = extendedQuotes ?? plainQuotes;
    if (quotes === undefined || unterminated.has(index)) return token;
    const end = stringEnd(stringFrame(index, start, hashes ?? '', quotes));
    return end === undefined ? token : content.slice(index, end);
  };

  const bareRegexEnd = (start: number, previous: string | undefined): number => {
    if (!startsExpression(previous) || /[ \t]/.test(content[start] ?? '')) return start;
    if (/[=!?&|+*%~<>^-]/.test(content[start - 2] ?? '')) return start;
    bareRegexPart.lastIndex = start;
    let groups = 0;
    let classes = 0;
    for (let match = bareRegexPart.exec(content); match; match = bareRegexPart.exec(content)) {
      const [part] = match;
      if (part === '/') return /[ \t]/.test(content[match.index - 1]) ? start : bareRegexPart.lastIndex;
      if (part === '[') classes++;
      if (part === ']' && classes > 0) classes--;
      if (classes > 0) continue;
      if (part === '(') groups++;
      if (part === ')' && --groups < 0) return start;
    }
    return start;
  };

  const regexEnd = (start: number, hashCount: number): number => {
    multilineRegexStart.lastIndex = start;
    const multiline = multilineRegexStart.test(content);
    closingIndex ??= buildClosingIndex(content);
    const position = atOrAfter(closingIndex.positions.get(hashCount) ?? [], start);
    if (multiline) return position === undefined ? start : position + 1 + hashCount;
    const newline = atOrAfter(closingIndex.newlines, start);
    if (position !== undefined && (newline === undefined || position < newline)) return position + 1 + hashCount;
    return newline ?? start;
  };

  const stringEnd = (opening: StringFrame): number | undefined => {
    const stack: (StringFrame | InterpolationFrame)[] = [opening];
    let index = opening.start;
    while (stack.length > 0) {
      const top = stack.length - 1;
      const frame = stack[top];
      if (index >= content.length) {
        stack.pop();
        if ('depth' in frame) continue;
        // An unterminated string contributes only its opening delimiter as a token.
        unterminated.add(frame.opening);
        index = frame.start;
      } else if ('depth' in frame) {
        const tokenStart = index;
        code.lastIndex = tokenStart;
        const [token, hashes, extendedQuotes, regexSlash, plainQuotes] = code.exec(content)!;
        index = code.lastIndex;
        if (token === '/*') index = blockCommentEnd(content, index);
        if (regexSlash !== undefined) index = regexEnd(index, hashes.length);
        if (token === '/') index = bareRegexEnd(index, frame.previous);
        if (!/^\s|^\/\/|^\/\*/.test(token)) frame.previous = token;
        if (token === '(') frame.depth++;
        if (token === ')' && --frame.depth === 0) stack.pop();
        const quotes = extendedQuotes ?? plainQuotes;
        if (quotes !== undefined && !unterminated.has(tokenStart)) {
          stack.push(stringFrame(tokenStart, index, hashes ?? '', quotes));
        }
      } else if (content.startsWith(frame.closing, index)) {
        index += frame.closing.length;
        stack.pop();
        if (stack.length === 0) return index;
      } else if (content.startsWith(frame.escape, index)) {
        index += frame.escape.length;
        if (content[index] === '(') stack.push({ depth: 1 });
        index++;
      } else {
        index++;
      }
    }
    return undefined;
  };

  return readToken;
};

const packageIdentifier = (tokens: readonly string[], index: number, label: string): string | undefined => {
  if (!['name', 'url', 'path', 'id'].includes(label) || tokens[index + 1] !== ':') return undefined;
  const literal = staticStringValue(tokens[index + 2] ?? '');
  if (literal === undefined || ![',', ')'].includes(tokens[index + 3])) return undefined;
  const identity = label === 'url' || label === 'path'
    ? literal.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/i, '') : literal;
  return identity.toLowerCase();
};

const staticStringValue = (token: string): string | undefined => {
  const match = /^(#*)"(?!"")(.*)"\1$/s.exec(token);
  if (!match) return undefined;
  const [, delimiter, value] = match;
  return value.includes('\\' + delimiter) ? undefined : value;
};
