export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '/' || token === '%') {
      const previous = previousSignificantToken(tokens, tokens.length - 1);
      if (expectsRegexp(tokens[previous] ?? '\n', tokens[previousSignificantToken(tokens, previous - 1)])) {
        const end = readRegexp(content, match.index);
        if (end !== undefined) {
          pattern.lastIndex = end;
          tokens.push('//');
          continue;
        }
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const opensSingletonClass = (tokens: string[], index: number): boolean =>
  tokens[index] === 'class' &&
  ['\n', ';', '=', 'do'].includes(tokens[previousSignificantToken(tokens, index - 1)] ?? '\n');

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const previousSignificantToken = (tokens: string[], start: number): number => {
  while (start >= 0 && isSpacing(tokens[start])) start--;
  return start;
};

const expectsRegexp = (token: string, previous?: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|return|when|then|else)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation = false) => {
  const opening = /\/|%(r|[qQwWiIxs]?)([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const isRegexp = match[0] === '/' || match[1] === 'r';
  if (!isRegexp && !inInterpolation) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    isRegexp,
    interpolates: !/^[qwis]$/.test(match[1] ?? ''),
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const readRegexp = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|#\{|[\s\S]/y;
  const plainLiteralPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'gy');
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.delimiters === 0) {
      offset++;
      if (frame.isRegexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces > 0 ? expressionPart :
      frame.interpolates ? literalPart : plainLiteralPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (token === '#{' && frame.interpolates) {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if ((token === '/' || token === '%') && frame.regexpExpected) {
        const nested = literalFrame(content, offset, true);
        if (nested) {
          frames.push(nested);
          frame.previous = token;
          frame.regexpExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.regexpExpected = expectsRegexp(token, frame.previous);
      frame.previous = token;
    }
    offset = part.lastIndex;
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
