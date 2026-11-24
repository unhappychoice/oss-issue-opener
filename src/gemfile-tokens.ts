export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && expectsRegexp(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('/…/');
        continue;
      }
    }
    if (token.startsWith('<<')) {
      if (followsClassKeyword(tokens)) {
        tokens.push('<<');
        pattern.lastIndex -= token.length - 2;
        continue;
      }
      const indented = /^<<[-~]/.test(token);
      const delimiter = token.slice(indented ? 3 : 2).replace(/^['"`]|['"`]$/g, '');
      pending.push({ delimiter, indented });
      tokens.push('""');
      continue;
    }
    tokens.push(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  return tokens;
};

const expectsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  if (index < 0 || /^(?:\n|;|[=(\[,~?!:]|=>|&&|\|\|)$/.test(tokens[index])) return true;
  return /^(?:if|elsif|unless|when|do|return)$/.test(tokens[index]) &&
    tokens[previousTokenIndex(tokens, index)] !== '.';
};

const literalDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;

  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const literalEnd = (
  content: string,
  start: number,
  delimiter: string,
  interpolates: boolean,
): number | undefined => {
  const closing = literalDelimiters.get(delimiter) ?? delimiter;
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (char === '\\') index++;
    else if (interpolates && content.startsWith('#{', index)) {
      const end = interpolationEnd(content, index + 2);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === closing && --depth === 0) return index + 1;
    else if (delimiter !== closing && char === delimiter) depth++;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = /#[^\n]*|%([qQwWiIxs]?)([^\p{L}\p{N}\s])|\\\r?\n|:\w+|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./uy;
  pattern.lastIndex = start;
  const tokens: string[] = [];
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const [token, type, delimiter] = match;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    if (token === '{') depth++;
    if (token.startsWith('#')) continue;
    const end = delimiter && expectsRegexp(tokens)
      ? literalEnd(content, pattern.lastIndex, delimiter, !/^[qwis]$/.test(type))
      : interpolationLiteralEnd(content, match.index, token, tokens);
    tokens.push(end === undefined ? token : '""');
    if (end !== undefined) pattern.lastIndex = end;
  }
  return undefined;
};

const interpolationLiteralEnd = (
  content: string,
  start: number,
  token: string,
  tokens: string[],
): number | undefined => {
  if (token === '"' || token === "'" || token === '`') {
    return literalEnd(content, start + 1, token, token !== "'");
  }
  if ((token === '/' || token === '%') && expectsRegexp(tokens)) return regexpEnd(content, start);
  return undefined;
};

const followsClassKeyword = (tokens: string[]): boolean => {
  const classIndex = previousTokenIndex(tokens);
  if (tokens[classIndex] !== 'class') return false;
  const index = previousTokenIndex(tokens, classIndex);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
};

const previousTokenIndex = (tokens: string[], before = tokens.length): number => {
  let index = before - 1;
  while (index >= 0 && isTokenSpacing(tokens[index])) index--;
  return index;
};

const isTokenSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const heredocEnd = (content: string, start: number, delimiter: string, indented: boolean): number => {
  const lines = /([^\n]*)(?:\n|$)/g;
  lines.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = lines.exec(content)) !== null && match[0]) {
    const line = match[1].replace(/\r$/, '');
    if ((indented ? line.replace(/^[\t ]*/, '') : line) === delimiter) return lines.lastIndex;
  }
  return content.length;
};
