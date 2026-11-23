export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let regexpExpected = true;
  let classHeader = false;
  let regexpCommand = false;
  let afterKernelDot = false;
  const assignedCommands = new Set<string>();
  const assignment = /[^\S\n]*=(?!=|~|>)/y;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = readToken(pattern, match, content, regexpExpected);
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (((token === '/' || token === '%') && regexpExpected) ||
      (regexpCommand && isCommandRegexp(content, match.index, token, tokens.at(-1)))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined && (!regexpCommand || !/^\w$/.test(content[end] ?? ''))) {
        pattern.lastIndex = end;
        tokens.push('/.../');
        previous = '/.../';
        regexpExpected = false;
        classHeader = false;
        regexpCommand = false;
        continue;
      }
    }
    if (token.startsWith('<<') && classHeader) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      regexpExpected = false;
      classHeader = false;
      continue;
    }
    if (!isSpacing(token)) {
      regexpCommand = afterKernelDot && regexpCommands.has(token);
      if (regexpCommands.has(token) && /^(?:\n|;|do|then|else)$/.test(previous)) {
        assignment.lastIndex = pattern.lastIndex;
        if (assignment.test(content)) assignedCommands.add(token);
        regexpCommand = !assignedCommands.has(token);
      }
      afterKernelDot = token === '.' && previous === 'Kernel';
      classHeader = token === 'class' && /^(?:\n|;|do|\{|then|else|end|=|\(|,)$/.test(previous);
      regexpExpected = expectsRegexp(token, previous);
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const regexpCommands = new Set(['warn', 'puts', 'print', 'p', 'Array', 'String', 'log']);

const isCommandRegexp = (content: string, start: number, token: string, spacing?: string): boolean => {
  if (spacing === undefined || !isSpacing(spacing)) return false;
  if (token === '%') return content.startsWith('%r', start);
  const next = content[start + 1];
  return token === '/' && next !== undefined && !/[\s=]/.test(next);
};

const readToken = (pattern: RegExp, match: RegExpExecArray, content: string, operandExpected: boolean): string => {
  if (match[0] !== '?' || !operandExpected) return match[0];
  const character = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  character.lastIndex = match.index;
  const literal = character.exec(content);
  if (!literal) return match[0];
  pattern.lastIndex = character.lastIndex;
  return literal[0];
};

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|,|&&|\|\||\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation = false) => {
  const opening = /\/|%([rqQ]?)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] === undefined || match[1] === 'r';
  if (!regexp && !inInterpolation) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp,
    interpolated: match[1] !== 'q',
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
  const regexpPart = /\\[\s\S]|#\{|[\s\S]/y;
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
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces === 0 ? regexpPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = frame.braces === 0 ? match[0] : readToken(part, match, content, frame.regexpExpected);
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (frame.interpolated && token === '#{') {
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
      frame.regexpExpected = token === '{' || expectsRegexp(token, frame.previous);
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
