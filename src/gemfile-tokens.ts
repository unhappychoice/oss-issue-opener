export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const regexp = regexpEnd(content, match.index, token, previous);
    if (regexp !== undefined) {
      pattern.lastIndex = regexp;
      previous = content.slice(match.index, regexp);
      tokens.push(previous);
      classHeader = false;
      continue;
    }
    const singletonClass = classHeader && token.startsWith('<<');
    if (!isSpacing(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      previous = regexpContext(token, previous);
    }
    if (singletonClass) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      continue;
    }
    if (token.startsWith('<<')) {
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const expressionStart = /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:|!|do|if|elsif|unless|when)$/;
const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpContext = (token: string, previous: string): string =>
  previous === '.' && /^(?:do|if|elsif|unless|when)$/.test(token) ? `.${token}` : token;

const regexpEnd = (content: string, start: number, token: string, previous: string): number | undefined => {
  if ((token !== '/' && token !== '%') || !expressionStart.test(previous)) return undefined;
  const opening = /\/|%r([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = delimitedEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const delimitedEnd = (content: string, start: number, opening: string, interpolated: boolean): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  let offset = start;
  while (offset < content.length) {
    const char = content[offset++];
    if (char === closing && --depth === 0) return offset;
    if (char === '\\') offset++;
    if (char === opening && opening !== closing) depth++;
    if (interpolated && char === '#' && content[offset] === '{') {
      const end = interpolationEnd(content, offset + 1);
      if (end === undefined) return undefined;
      offset = end;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'y');
  const percentString = /%([qQwWiIx]?)([^\w\s\u0080-\uffff])/y;
  pattern.lastIndex = start;
  let depth = 1;
  let previous = '{';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (isSpacing(token) || token.startsWith('#')) continue;
    const regexp = regexpEnd(content, match.index, token, previous);
    percentString.lastIndex = match.index;
    const percent = token === '%' && expressionStart.test(previous) ? percentString.exec(content) : null;
    if (regexp !== undefined || percent !== null) {
      const end = percent
        ? delimitedEnd(content, percentString.lastIndex, percent[2], !/[qwi]/.test(percent[1]))
        : regexp;
      if (end === undefined) return undefined;
      pattern.lastIndex = end;
      previous = 'literal';
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    previous = regexpContext(token, previous);
  }
  return undefined;
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
