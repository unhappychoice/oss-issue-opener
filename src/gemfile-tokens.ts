export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '%' || token === '/') {
      const end = token === '%' || expectsRegexp(tokens)
        ? regexpEnd(content, match.index)
        : commandRegexpEnd(content, match.index, tokens);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
    }
    if (token.startsWith('<<')) {
      // In a singleton class header, << starts the receiver expression.
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
  const previous = tokens[index] ?? '\n';
  return /^(?:\n|;|=|=>|~|\(|\[|,|&&|\|\||\?|:|!)$/.test(previous) ||
    (/^(?:do|if|elsif|unless)$/.test(previous) && tokens[previousTokenIndex(tokens, index - 1)] !== '.');
};

const literalDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const commandRegexpEnd = (content: string, start: number, tokens: string[]): number | undefined => {
  if (!/^[ \t]+$/.test(tokens.at(-1) ?? '') ||
    !/^[a-zA-Z_]\w*[!?]?$/.test(tokens[previousTokenIndex(tokens)] ?? '') ||
    !/^\S/.test(content[start + 1] ?? '')) return undefined;
  const end = regexpEnd(content, start);
  if (end === undefined) return undefined;
  const literal = content.slice(start, end);
  // A spaced trailing slash can start a continued division expression.
  return /\n(?:[\s\S]*\S|[ \t]*)\/[imxounes]*$/.test(literal) ? end : undefined;
};

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
  content: string, start: number, delimiter: string, interpolates: boolean,
): number | undefined => {
  const closing = literalDelimiters.get(delimiter) ?? delimiter;
  const part = /\\[\s\S]|[\s\S]/gu;
  part.lastIndex = start;
  let depth = 1;
  for (let token = part.exec(content); token; token = part.exec(content)) {
    if (interpolates && token[0] === '#' && content[part.lastIndex] === '{') {
      const end = interpolationEnd(content, part.lastIndex + 1);
      if (end === undefined) return undefined;
      part.lastIndex = end;
      continue;
    }
    if (token[0] === closing && --depth === 0) return part.lastIndex;
    if (token[0] === delimiter && delimiter !== closing) depth++;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const part = /#[^\n]*|%([qQwWiIrxs])([^\p{L}\p{N}\s])|\\[\s\S]|\w+[!?]?|&&|\|\||=>|[\s\S]/gu;
  part.lastIndex = start;
  const tokens: string[] = [];
  let depth = 1;
  for (let match = part.exec(content); match; match = part.exec(content)) {
    const [token, percentType, delimiter] = match;
    if (token.startsWith('#')) continue;
    if (token === '}' && --depth === 0) return part.lastIndex;
    if (token === '{') depth++;
    const end = delimiter
      ? literalEnd(content, part.lastIndex, delimiter, 'QWIrx'.includes(percentType))
      : interpolationLiteralEnd(content, token, match.index, tokens);
    if (end !== undefined) part.lastIndex = end;
    tokens.push(end === undefined ? token : '""');
  }
  return undefined;
};

const interpolationLiteralEnd = (
  content: string, token: string, start: number, tokens: string[],
): number | undefined => {
  if (token === '/' && expectsRegexp(tokens)) return regexpEnd(content, start);
  if (token === '%' && expectsRegexp(tokens)) {
    const opening = /%([^\p{L}\p{N}\s])/uy;
    opening.lastIndex = start;
    const match = opening.exec(content);
    if (match) return literalEnd(content, opening.lastIndex, match[1], true);
  }
  if (token === "'" || token === '"' || token === '`') {
    return literalEnd(content, start + 1, token, token !== "'");
  }
  return undefined;
};

const followsClassKeyword = (tokens: string[]): boolean => {
  let index = previousTokenIndex(tokens);
  if (tokens[index--] !== 'class') return false;
  index = previousTokenIndex(tokens, index);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
};

const previousTokenIndex = (tokens: string[], index = tokens.length - 1): number => {
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
