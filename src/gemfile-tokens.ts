export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let regexpExpected = true;
  let classHeader = false;
  let regexpCommand = false;
  const assignedNames = new Set<string>();
  const assignment = /[^\S\n]*(?:&&|\|\||[+*/%&|^<>-])?=(?!=|~|>)/y;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = readToken(pattern, match, content, regexpExpected);
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (((token === '/' || token === '%') && regexpExpected) ||
      (regexpCommand && isCommandLiteral(content, match.index, token, tokens.at(-1)))) {
      const end = literalEnd(content, match.index);
      if (end !== undefined && (!regexpCommand || !/^\w$/.test(content[end] ?? ''))) {
        pattern.lastIndex = end;
        const literal = token === '/' || content.startsWith('%r', match.index) ? '/.../' : '%...%';
        tokens.push(literal);
        previous = literal;
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
      regexpCommand = false;
      if (isMethodName(token)) {
        if (previous === '.') {
          regexpCommand = true;
        } else if (!rubyKeywords.has(token) && /^(?:\n|;|do|then|else)$/.test(previous)) {
          assignment.lastIndex = pattern.lastIndex;
          if (assignment.test(content)) assignedNames.add(token);
          regexpCommand = !assignedNames.has(token);
        }
      }
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

const isMethodName = (token: string): boolean => /^[a-zA-Z_]\w*[!?]?$/.test(token);

const rubyKeywords = new Set([
  'BEGIN', 'END', '__ENCODING__', '__FILE__', '__LINE__', 'alias', 'and', 'begin', 'break', 'case', 'class',
  'def', 'defined?', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'module', 'next',
  'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then', 'true', 'undef',
  'unless', 'until', 'when', 'while', 'yield',
]);

const isCommandLiteral = (content: string, start: number, token: string, spacing?: string): boolean => {
  if (spacing === undefined || !isSpacing(spacing)) return false;
  if (token === '%') return /^[rqQ]$/.test(content[start + 1] ?? '');
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
  (previous !== '.' && /^(?:!|do|if|elsif|unless|then|return)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rqQ]?)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] === undefined || match[1] === 'r';
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

const literalEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const interpolatedPart = /\\[\s\S]|#\{|[\s\S]/y;
  const plainPart = /\\[\s\S]|[\s\S]/y;
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
    const literalPart = frame.interpolated ? interpolatedPart : plainPart;
    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = frame.braces === 0 ? match[0] : readToken(part, match, content, frame.regexpExpected);
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if ((token === '/' || token === '%') && frame.regexpExpected) {
        const nested = literalFrame(content, offset);
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
