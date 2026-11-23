export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '/' || token === '%') {
      const expected = expectsRegexpAfter(tokens);
      const commandArgument = token === '/' && startsCommandRegexp(tokens, content[pattern.lastIndex]);
      const end = expected || commandArgument ? regexpEnd(content, match.index) : undefined;
      if (end !== undefined && (expected || endsCommandRegexp(content, match.index, end))) {
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const expectsRegexpAfter = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  return index < 0 || expectsRegexp(tokens[index], tokens[previousTokenIndex(tokens, index)]);
};

const startsCommandRegexp = (tokens: string[], next: string | undefined): boolean => {
  if (!next || /\s/.test(next) || !/^[ \t]+$/.test(tokens.at(-1) ?? '')) return false;
  const index = previousTokenIndex(tokens);
  if (!/^[a-z_]\w*[!?]?$/.test(tokens[index] ?? '')) return false;
  const before = previousTokenIndex(tokens, index);
  return before < 0 || /^(?:\n|;|do)$/.test(tokens[before]);
};

// A bare command argument is ambiguous with division. Require a complete multiline statement.
const endsCommandRegexp = (content: string, start: number, end: number): boolean =>
  content.slice(start, end).includes('\n') && /^[ \t\r]*(?:\n|;|#|$)/.test(content.slice(end));

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|not)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, allowPercentString = false) => {
  const opening = allowPercentString
    ? /\/|%([rqQwWiIxs]?)([^\p{L}\p{N}])/uy
    : /\/|%(r)([^\p{L}\p{N}])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  const kind = match[1];
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp: kind === undefined || kind === 'r',
    interpolates: kind === undefined || !['q', 'w', 'i', 's'].includes(kind),
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|[\s\S]/uy;
  const expressionPart = new RegExp(tokenPattern, 'gy');
  const options = /[imxounes]*/y;
  let offset = initial.start;

  // Interpolated expressions can contain literals with their own interpolation.
  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content.startsWith(frame.closing, offset) && --frame.delimiters === 0) {
      offset += frame.closing.length;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (frame.interpolates && token === '#' && content[part.lastIndex] === '{') {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
        part.lastIndex++;
      }
    } else if (!token.startsWith('#') && !isTokenSpacing(token)) {
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
