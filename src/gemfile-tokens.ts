export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let literalExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (startsLiteral(content, match.index, token, previous, literalExpected)) {
      const end = literalEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('literal');
        previous = 'literal';
        literalExpected = false;
        classHeader = false;
        continue;
      }
    }
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      literalExpected = false;
      classHeader = false;
      continue;
    }
    if (!isSpacing(token)) {
      classHeader = token === 'class' && /^(?:\n|;|do|\{|then|end|=)$/.test(previous);
      literalExpected = expectsLiteral(token, previous);
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const expectsLiteral = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|when|return|then)$/.test(token));

const startsLiteral = (
  content: string,
  offset: number,
  token: string,
  previous: string,
  expected: boolean,
): boolean => {
  if (token !== '/') return token === '%' && expected;
  return expected || (
    /^[A-Za-z_]\w*[!?]$/.test(previous) &&
    /\s/.test(content[offset - 1] ?? '') &&
    /\S/.test(content[offset + 1] ?? '')
  );
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rQqWwIisx]?)([^\s\p{L}\p{N}])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    regexp: match[1] === undefined || match[1] === 'r',
    interpolates: !/^[qwis]$/.test(match[1] ?? ''),
    delimiters: 1,
    braces: 0,
    previous: '{',
    literalExpected: true,
  };
};

const literalEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'y');
  const flags = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.delimiters === 0) {
      offset++;
      if (frame.regexp) {
        flags.lastIndex = offset;
        flags.exec(content);
        offset = flags.lastIndex;
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
        part.lastIndex++;
        frame.braces = 1;
        frame.previous = '{';
        frame.literalExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if (startsLiteral(content, offset, token, frame.previous, frame.literalExpected)) {
        const nested = literalFrame(content, offset);
        if (nested) {
          frames.push(nested);
          frame.previous = 'literal';
          frame.literalExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.literalExpected = expectsLiteral(token, frame.previous);
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
