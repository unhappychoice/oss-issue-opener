export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && expectsRegexp(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
    }
    if (token.startsWith('<<')) {
      if (opensSingletonClass(tokens, previousSignificantToken(tokens, tokens.length - 1))) {
        tokens.push('<<');
        pattern.lastIndex = match.index + 2;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|::|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|\.{2,3}|[^\S\n]+|\n|./;

const opensSingletonClass = (tokens: string[], index: number): boolean =>
  tokens[index] === 'class' &&
  ['\n', ';', '=', 'do'].includes(tokens[previousSignificantToken(tokens, index - 1)] ?? '\n');

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const previousSignificantToken = (tokens: string[], start: number): number => {
  while (start >= 0 && isSpacing(tokens[start])) start--;
  return start;
};

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

const expectsRegexp = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const previous = tokens[index] ?? '\n';
  const receiverOperator = tokens[previousSignificantToken(tokens, index - 1)];
  return receiverOperator !== '.' && receiverOperator !== '::' &&
    /^(?:\n|;|=|=>|\.{2,3}|~|\(|\[|\{|,|&|\||!|\?|:|do|if|elsif|unless|when|then|else|return)$/.test(previous);
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined =>
  literalEnd(content, start, /\/|%r([^a-zA-Z0-9\u0080-\uffff\s])/y);

const literalEnd = (content: string, start: number, opening: RegExp): number | undefined => {
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[1] ?? '/';
  const isRegexp = match[0] === '/' || match[0].startsWith('%r');
  const interpolates = !match[0].startsWith('%q');
  const closing = pairedDelimiters.get(delimiter) ?? delimiter;
  let depth = 1;

  for (let offset = opening.lastIndex; offset < content.length; offset++) {
    const char = content[offset];
    if (char === '\\') {
      offset++;
    } else if (char === closing) {
      if (--depth === 0) {
        if (!isRegexp) return offset + 1;
        const options = /[imxounes]*/y;
        options.lastIndex = offset + 1;
        options.exec(content);
        return options.lastIndex;
      }
    } else if (interpolates && char === '#' && content[offset + 1] === '{') {
      const end = interpolationEnd(content, offset + 2);
      if (end === undefined) return undefined;
      offset = end - 1;
    } else if (char === delimiter) {
      depth++;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'y');
  pattern.lastIndex = start;
  let depth = 1;
  const tokens = ['{'];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (isSpacing(token) || token.startsWith('#')) continue;
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    if ((token === '/' || token === '%') && expectsRegexp(tokens)) {
      const end = regexpEnd(content, match.index) ??
        literalEnd(content, match.index, /%[qQ]?([^a-zA-Z0-9\u0080-\uffff\s])/y);
      if (end !== undefined) pattern.lastIndex = end;
    }
    tokens.push(token);
  }
  return undefined;
};
