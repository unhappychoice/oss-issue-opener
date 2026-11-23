export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '/' || token === '%' || token === '?') {
      const end = literalEndAt(content, match.index, token, tokens);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push(content.slice(match.index, end));
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const expectsExpressionAfter = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  return expectsExpression(tokens[index] ?? '\n', tokens[previousTokenIndex(tokens, index - 1)]);
};

const literalEndAt = (content: string, start: number, token: string, tokens: string[]): number | undefined => {
  if (!expectsExpressionAfter(tokens) &&
    !(token === '/' && /^\/\S/.test(content.slice(start, start + 2)) && followsRegexpCommand(tokens))) {
    return undefined;
  }
  return token === '?' ? characterEnd(content, start) : literalEnd(content, start);
};

const followsRegexpCommand = (tokens: string[]): boolean => {
  if (!/^[^\S\n]+$/.test(tokens.at(-1) ?? '')) return false;
  const method = previousTokenIndex(tokens);
  const separator = previousTokenIndex(tokens, method - 1);
  if (tokens[separator] === '.') return /^[a-z_]\w*[!?]?$/.test(tokens[method] ?? '');
  return tokens[method] === 'warn' &&
    expectsExpression(tokens[separator] ?? '\n', tokens[previousTokenIndex(tokens, separator - 1)]) &&
    !tokens.some(isWarnAssignment);
};

const isWarnAssignment = (token: string, index: number, tokens: string[]): boolean => {
  if (token === 'warn=') return true;
  if (token !== 'warn' || tokens[previousTokenIndex(tokens, index - 1)] === '.') return false;
  while (isTokenSpacing(tokens[++index] ?? '')) {}
  return /^(?:=(?![=~])|(?:&&|\|\||[+*/%&|^-])=)/.test(tokens.slice(index, index + 2).join(''));
};

const expectsExpression = (token: string, previous?: string): boolean =>
  /^(?:\n|;|=|=>|~|\?|:|\(|\[|\{|,|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless)$/.test(token));

const characterEnd = (content: string, start: number): number | undefined => {
  const character = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  character.lastIndex = start;
  return character.test(content) ? character.lastIndex : undefined;
};

const closingDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rqQ])([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] !== 'q' && match[1] !== 'Q';
  const delimiter = match[2] ?? '/';
  return {
    start: opening.lastIndex, delimiter, closing: closingDelimiters.get(delimiter) ?? delimiter,
    regexp, interpolates: match[1] !== 'q', nesting: 1, braces: 0,
    previous: '{', expressionExpected: true,
  };
};

const literalEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|#\{|[\s\S]/y;
  const rawLiteralPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = initial.start;
  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.nesting === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces > 0 ? expressionPart : frame.interpolates ? literalPart : rawLiteralPart;
    part.lastIndex = offset;
    const token = part.exec(content)?.[0];
    if (token === undefined) return undefined;
    if (frame.braces === 0) {
      if (token === frame.delimiter && frame.delimiter !== frame.closing) frame.nesting++;
      if (token === '#{') {
        frame.braces = 1;
        frame.previous = '{';
        frame.expressionExpected = true;
      }
    } else if (!isTokenSpacing(token) && !token.startsWith('#') && !token.startsWith('=begin')) {
      if ((token === '/' || token === '%') && frame.expressionExpected) {
        const nested = literalFrame(content, offset);
        if (nested) {
          frames.push(nested);
          frame.previous = 'literal';
          frame.expressionExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '?' && frame.expressionExpected) {
        const end = characterEnd(content, offset);
        if (end !== undefined) {
          frame.previous = 'literal';
          frame.expressionExpected = false;
          offset = end;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.expressionExpected = expectsExpression(token, frame.previous);
      frame.previous = token;
    }
    offset = part.lastIndex;
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
