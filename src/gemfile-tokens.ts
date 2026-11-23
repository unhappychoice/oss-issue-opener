export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let putsIsLocal = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '?' && content[pattern.lastIndex] === '/' && startsRegexp(tokens)) {
      tokens.push('?/');
      pattern.lastIndex++;
      continue;
    }
    if (/^puts=?$/.test(token) && !putsIsLocal) {
      const assignmentStart = match.index + 'puts'.length;
      putsIsLocal = tokens[previousTokenIndex(tokens)] !== '.' &&
        /^[ \t]*=(?!=|>|~)/.test(content.slice(assignmentStart));
    }
    const slashArgument = token === '/' && startsPutsRegexp(content, match.index, tokens, putsIsLocal);
    if ((token === '/' || token === '%') && (slashArgument || startsRegexp(tokens))) {
      const literal = readRegexp(content, match.index);
      if (literal) {
        tokens.push(literal);
        pattern.lastIndex = match.index + literal.length;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&(?!=)|\|\|(?!=)|[^\S\n]+|\n|./;

const startsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  return expectsRegexp(tokens[index] ?? '\n', tokens[previousTokenIndex(tokens, index)]);
};

const startsPutsRegexp = (content: string, slash: number, tokens: string[], putsIsLocal: boolean): boolean => {
  if (!/[ \t]/.test(content[slash - 1] ?? '') || /[\s=]/.test(content[slash + 1] ?? '')) return false;
  const index = previousTokenIndex(tokens);
  return tokens[index] === 'puts' && (!putsIsLocal || tokens[previousTokenIndex(tokens, index)] === '.');
};

const expectsRegexp = (token: string, previous?: string): boolean =>
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:if|elsif|unless|while|until|when|do)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation = false) => {
  const opening = inInterpolation ? /\/|%(r|[qQwWiIxs]?)([^\w\s])/y : /\/|%(r)([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  const kind = match[1] ?? 'r';
  return {
    delimiter,
    regexp: kind === 'r',
    interpolates: !/^[qwis]$/.test(kind),
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const readRegexp = (content: string, start: number): string | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const interpolatedPart = /\\[\s\S]|#\{|[\s\S]/y;
  const literalPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'gy');
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
    const bodyPart = frame.interpolates ? interpolatedPart : literalPart;
    const part = frame.braces === 0 ? bodyPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !isTokenSpacing(token)) {
      if (token === '?' && content[part.lastIndex] === '/' && frame.regexpExpected) {
        frame.previous = '?/';
        frame.regexpExpected = false;
        offset = part.lastIndex + 1;
        continue;
      }
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
