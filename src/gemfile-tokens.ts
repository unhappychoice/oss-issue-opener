export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let classHeader = false;
  let warnMayBeLocal = false;
  let warnCommand = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const literal = literalEnd(content, match.index, token, previous, warnCommand);
    if (literal !== undefined) {
      pattern.lastIndex = literal;
      previous = content.slice(match.index, literal);
      tokens.push(previous);
      classHeader = false;
      warnCommand = false;
      continue;
    }
    const singletonClass = classHeader && token.startsWith('<<');
    if (!isSpacing(token)) {
      classHeader = token === 'class' && namespaceStart.test(previous);
      warnCommand = false;
      if (token === 'warn' && previous !== '.') {
        warnMayBeLocal ||= warnBindingFollows(content, pattern.lastIndex);
        warnCommand = !warnMayBeLocal;
      }
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

const namespaceStart = /^(?:\n|;|=|do|\(|\{|then)$/;

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const expressionStart = /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:|!|do|if|elsif|unless|when)$/;
const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpContext = (token: string, previous: string): string =>
  previous === '.' && /^(?:do|if|elsif|unless|when)$/.test(token) ? `.${token}` : token;

const warnBindingFollows = (content: string, offset: number): boolean => {
  // Treat possible bindings conservatively in this lexer, which does not resolve Ruby locals.
  const binding = /[^\S\n]*(?:=(?!=|>|~)|[,):|]|in\b|[-+*/%&|^]=|\|\|=|&&=)/y;
  binding.lastIndex = offset;
  return binding.test(content);
};

const isCommandRegexp = (content: string, start: number, token: string): boolean =>
  token === '/' && /[^\S\n]/.test(content[start - 1] ?? '') && /[^\s=]/.test(content[start + 1] ?? '');

const literalEnd = (
  content: string,
  start: number,
  token: string,
  previous: string,
  warnCommand = false,
): number | undefined => {
  if (token !== '/' && token !== '%') return undefined;
  if (!expressionStart.test(previous) && !(warnCommand && isCommandRegexp(content, start, token))) return undefined;
  const opening = /\/|%([qQwWiIxrs]?)([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = delimitedEnd(content, opening.lastIndex, match[2] ?? '/', !/[qwis]/.test(match[1] ?? ''));
  if (token === '%' && match[1] !== 'r') return end;
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
  pattern.lastIndex = start;
  let depth = 1;
  let previous = '{';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (isSpacing(token) || token.startsWith('#')) continue;
    const literal = literalEnd(content, match.index, token, previous);
    if (literal !== undefined) {
      pattern.lastIndex = literal;
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
