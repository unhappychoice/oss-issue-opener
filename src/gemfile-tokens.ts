export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let expressionExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let token = match[0];
    if (token.startsWith('#')) continue;
    if (expressionExpected) {
      const end = expressionLiteralEnd(content, match);
      if (end !== undefined) {
        token = content.slice(match.index, end);
        pattern.lastIndex = end;
      }
    }
    // In a singleton class header, << opens the scope without starting a heredoc.
    if (token.startsWith('<<') && classHeader) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      expressionExpected = false;
      classHeader = false;
      continue;
    }
    if (!isSpacing(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      expressionExpected = expectsExpression(token, previous);
      previous = token;
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

const tokenPattern = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;
const regexpOpening = /\/|%r([^a-zA-Z0-9\s\u0080-\uffff])/y;
const percentOpening = /%(?:[qQwWiIxs])?([^a-zA-Z0-9\s\u0080-\uffff])/y;
const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);
const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);
const expectsExpression = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|&&|\|\||\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:do|if|elsif|unless|case|when|return|and|or|not)$/.test(token));

const expressionLiteralEnd = (content: string, match: RegExpExecArray): number | undefined => {
  if (match[0] === '/' || match[0] === '%') {
    return literalEnd(content, match.index, regexpOpening) ??
      literalEnd(content, match.index, percentOpening);
  }
  if (match[0] === '?') {
    const character = /\?(?:\\[^\n]|[^\s\\])/uy;
    character.lastIndex = match.index;
    if (character.test(content)) return character.lastIndex;
  }
  return undefined;
};

const literalEnd = (content: string, start: number, opening: RegExp): number | undefined => {
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[1] ?? '/';
  const closing = pairedDelimiters.get(delimiter) ?? delimiter;
  const interpolates = !/^%[qwis]/.test(match[0]);
  let depth = 1;
  let offset = opening.lastIndex;
  while (offset < content.length) {
    const character = content[offset++];
    if (character === closing && --depth === 0) {
      if (opening !== regexpOpening) return offset;
      const options = /[imxounes]*/y;
      options.lastIndex = offset;
      options.exec(content);
      return options.lastIndex;
    }
    if (character === '\\') offset++;
    else if (interpolates && character === '#' && content[offset] === '{') {
      const end = interpolationEnd(content, offset + 1);
      if (end === undefined) return undefined;
      offset = end;
    } else if (delimiter !== closing && character === delimiter) depth++;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'y');
  pattern.lastIndex = start;
  let previous = '{';
  let expressionExpected = true;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || isSpacing(token)) continue;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    if (token === '{') depth++;
    if (expressionExpected) {
      const end = expressionLiteralEnd(content, match);
      if (end !== undefined) {
        pattern.lastIndex = end;
        expressionExpected = false;
        previous = content.slice(match.index, end);
        continue;
      }
    }
    expressionExpected = expectsExpression(token, previous);
    previous = token;
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
