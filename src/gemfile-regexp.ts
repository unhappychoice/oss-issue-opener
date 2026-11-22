export const readCharacter = (content: string, start: number): string | undefined => {
  const character = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  character.lastIndex = start;
  return character.exec(content)?.[0];
};

export const expectsLiteral = (token: string, previous?: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless)$/.test(token));

export const readLiteral = (content: string, start: number, tokenPattern: RegExp): string | undefined => {
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
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.delimiters === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return content.slice(start, offset);
      continue;
    }
    const part = frame.braces > 0 ? expressionPart : frame.interpolated ? literalPart : rawLiteralPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const character = match[0] === '?' && frame.braces > 0 && frame.literalExpected
      ? readCharacter(content, offset) : undefined;
    const token = character ?? match[0];
    part.lastIndex = offset + token.length;
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.literalExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if ((token === '/' || token === '%') && frame.literalExpected) {
        const nested = literalFrame(content, offset);
        if (nested) {
          frames.push(nested);
          frame.previous = token;
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

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rqQw]?)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] === undefined || match[1] === 'r';
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp,
    interpolated: match[1] !== 'q' && match[1] !== 'w',
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    literalExpected: true,
  };
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);
