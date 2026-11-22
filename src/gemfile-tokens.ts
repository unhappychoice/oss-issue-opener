export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && regexpAllowedAfter(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
    }
    if (token.startsWith('<<')) {
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const opensSingletonClass = (tokens: string[]): boolean => {
  const classIndex = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[classIndex] !== 'class') return false;
  const preceding = tokens[previousSignificantToken(tokens, classIndex - 1)];
  return ['\n', ';', '=', 'do'].includes(preceding ?? '\n');
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const regexpAllowedAfter = (tokens: string[]): boolean => {
  const last = previousSignificantToken(tokens, tokens.length - 1);
  const preceding = previousSignificantToken(tokens, last - 1);
  return expectsRegexp(tokens[last], tokens[preceding]);
};

const expectsRegexp = (token = '\n', preceding?: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:)$/.test(token) ||
  (preceding !== '.' && /^(?:!|do|if|elsif|unless|return|when)$/.test(token));

const previousSignificantToken = (tokens: string[], index: number): number => {
  while (index >= 0 && isSpacing(tokens[index])) index--;
  return index;
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

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation: boolean) => {
  const opening = inInterpolation ? /\/|%(r|q|Q)?([^\w\s])/y : /\/|%(r)([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    start: opening.lastIndex,
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp: match[0] === '/' || match[1] === 'r',
    interpolates: match[1] !== 'q',
    depth: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start, false);
  if (!initial) return undefined;
  const frames = [initial];
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    const char = content[offset];
    if (frame.braces > 0) {
      expression.lastIndex = offset;
      const token = expression.exec(content)![0];
      const nested = (token === '/' || token === '%') && frame.regexpExpected
        ? literalFrame(content, offset, true)
        : undefined;
      offset = nested?.start ?? expression.lastIndex;
      if (nested) frames.push(nested);
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      if (!isSpacing(token) && !token.startsWith('#') && !token.startsWith('=begin')) {
        frame.regexpExpected = expectsRegexp(token, frame.previous);
        frame.previous = token;
      }
      continue;
    }

    offset++;
    if (char === frame.closing && --frame.depth === 0) {
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (!frames.length) return offset;
    } else if (char === '\\') {
      offset++;
    } else if (frame.interpolates && char === '#' && content[offset] === '{') {
      frame.braces = 1;
      frame.previous = '{';
      frame.regexpExpected = true;
      offset++;
    } else if (char === frame.delimiter && frame.delimiter !== frame.closing) {
      frame.depth++;
    }
  }
  return undefined;
};
