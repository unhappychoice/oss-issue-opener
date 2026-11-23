export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '%' || (token === '/' && expectsRegexp(tokens))) {
      const end = regexpEnd(content, match.index);
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

const regexpDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[1] ?? '/';
  const closing = regexpDelimiters.get(delimiter) ?? delimiter;
  const part = /\\[\s\S]|[\s\S]/g;
  part.lastIndex = opening.lastIndex;
  let depth = 1;
  for (let token = part.exec(content); token; token = part.exec(content)) {
    if (token[0] === closing && --depth === 0) {
      const options = /[imxounes]*/y;
      options.lastIndex = part.lastIndex;
      options.exec(content);
      return options.lastIndex;
    }
    if (delimiter !== closing && token[0] === delimiter) depth++;
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
