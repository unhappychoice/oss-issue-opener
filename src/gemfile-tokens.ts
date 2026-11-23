export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') &&
      (expectsRegexp(tokens) || followsPutsCommand(content, match.index, tokens))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('<regexp>');
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

const followsPutsCommand = (content: string, start: number, tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  if (tokens[index] !== 'puts' || !/^[ \t]+$/.test(tokens.at(-1) ?? '')) return false;
  if (content[start] === '/' && /[\s=]/.test(content[start + 1] ?? '')) return false;
  const previous = tokens[previousTokenIndex(tokens, index)] ?? '\n';
  return ['\n', ';', 'do', '{'].includes(previous);
};

const expectsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  const previous = tokens[index] ?? '\n';
  return /^(?:\n|;|=|=>|~|\(|\[|\{|,|[?!:&|])$/.test(previous) ||
    (/^(?:do|if|elsif|unless|when|return|and|or)$/.test(previous) &&
      tokens[previousTokenIndex(tokens, index)] !== '.');
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opener = /\/|%r([^a-zA-Z0-9\s\u0080-\uffff])/y;
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

const literalEnd = (content: string, start: number, opening: string, interpolates: boolean): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (char === '\\') index++;
    else if (interpolates && char === '#' && content[index + 1] === '{') {
      const end = interpolationEnd(content, index + 2);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === closing) {
      if (--depth === 0) return index + 1;
    } else if (opening !== closing && char === opening) depth++;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = /#[^\n]*|:\w+|\w+[!?]?|=>|\\\r?\n|[^\S\n]+|\n|./gy;
  pattern.lastIndex = start;
  const tokens: string[] = [];
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#')) continue;
    const end = expressionLiteralEnd(content, match.index, token, tokens);
    if (end !== undefined) {
      pattern.lastIndex = end;
      tokens.push('<literal>');
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    tokens.push(token);
  }
  return undefined;
};

const expressionLiteralEnd = (content: string, start: number, token: string, tokens: string[]): number | undefined => {
  if (token === '"' || token === "'" || token === '`') {
    return literalEnd(content, start + 1, token, token !== "'");
  }
  if ((token !== '/' && token !== '%') || !expectsRegexp(tokens)) return undefined;
  const end = regexpEnd(content, start);
  if (end !== undefined || token === '/') return end;
  const opener = /%([qQwWiIsx]?)([^a-zA-Z0-9\s\u0080-\uffff])/y;
  opener.lastIndex = start;
  const match = opener.exec(content);
  if (!match) return undefined;
  return literalEnd(content, opener.lastIndex, match[2], !/^[qwis]$/.test(match[1]));
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
