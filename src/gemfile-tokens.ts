export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '?' && content[pattern.lastIndex] === '/' && canStartRegexp(tokens)) {
      tokens.push('?/');
      pattern.lastIndex++;
      continue;
    }
    if ((token === '/' || token === '%') && canStartRegexp(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
    }
    if (token.startsWith('<<')) {
      // A singleton class uses the shift token where the pattern can match a heredoc opener.
      if (opensSingletonClass(tokens)) {
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

const canStartRegexp = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const previous = tokens[index] ?? '\n';
  if (/^(?:\n|;|=|=>|&&|\|\||~|\(|\[|,|\?|:)$/.test(previous)) return true;
  return /^(?:!|do|if|elsif|unless|when)$/.test(previous) &&
    tokens[previousSignificantToken(tokens, index - 1)] !== '.';
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const opener = /\/|%r([^\w\s])/y;
  opener.lastIndex = start;
  const match = opener.exec(content);
  if (!match) return undefined;
  const end = literalEnd(content, opener.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const parts = /%q([^\w\s])|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[^\n]*|[{}]|[^%'"#{}]+|[%'"]/y;
  parts.lastIndex = start;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = parts.exec(content)) !== null) {
    if (match[1]) {
      const end = literalEnd(content, parts.lastIndex, match[1], false);
      if (end === undefined) return undefined;
      parts.lastIndex = end;
    }
    if (match[0] === '{') depth++;
    if (match[0] === '}' && --depth === 0) return parts.lastIndex;
  }
  return undefined;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalEnd = (content: string, start: number, opening: string, interpolates: boolean): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    const character = content[index];
    if (character === closing && --depth === 0) return index + 1;
    if (character === opening && opening !== closing) depth++;
    if (interpolates && content.startsWith('#{', index)) {
      const end = interpolationEnd(content, index + 2);
      if (end === undefined) return undefined;
      index = end - 1;
    }
    if (character === '\\') index++;
  }
  return undefined;
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[index] !== 'class') return false;
  const previous = tokens[previousSignificantToken(tokens, index - 1)] ?? '\n';
  return ['\n', ';', '=', 'do'].includes(previous);
};

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
