export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (isComment(token)) continue;
    if ((token === '/' || token === '%') && canStartRegexp(tokens, content, match.index)) {
      const literal = readRegexp(content, match.index);
      if (literal !== undefined) {
        tokens.push(literal);
        pattern.lastIndex = match.index + literal.length;
        continue;
      }
    }
    if (token.startsWith('<<')) {
      // A singleton class uses the shift token where the pattern can match a heredoc opener.
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

export const opensGemfileBlock = (tokens: string[]): boolean =>
  tokens.includes('do') || opensMethod(tokens) || opensNamespace(tokens) ||
  /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '');

export const splitGemfileStatements = (tokens: string[]): string[][] => {
  const result: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  tokens.forEach((token) => {
    if (isSpacing(token)) return;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) result.push(current);
      current = [];
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      result.push([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      if (current.length) result.push(current);
      result.push(['end']);
      current = [];
      return;
    }
    if (token === 'end' && depth === 0 && current.length) {
      result.push(current);
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      result.push(current);
      current = [];
    }
  });
  if (current.length) result.push(current);
  return result;
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|=~|&&|\|\||[^\S\n]+|\n|./;

const opensSingletonClass = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[index] !== 'class') return false;
  const previous = tokens[previousSignificantToken(tokens, index - 1)] ?? '\n';
  return ['\n', ';', '=', 'do'].includes(previous);
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const previousSignificantToken = (tokens: string[], start: number): number => {
  while (start >= 0 && isSpacing(tokens[start])) start--;
  return start;
};

const isComment = (token: string): boolean => token.startsWith('#') || token.startsWith('=begin');

const canStartRegexp = (tokens: string[], content: string, start: number): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const token = tokens[index] ?? '\n';
  const previous = tokens[previousSignificantToken(tokens, index - 1)];
  return expectsRegexp(token, previous) ||
    ((token === 'puts' || token === 'warn') && index < tokens.length - 1 &&
      !/\s/.test(content[start + 1] ?? '') && (previous === '.' || !hasLocal(tokens, token)));
};

const hasLocal = (tokens: string[], name: string): boolean => {
  const scopes = [{ assigned: false }];
  for (const statement of splitGemfileStatements(tokens)) {
    if (statement[0] === 'end' && scopes.length > 1) scopes.pop();
    const current = scopes.at(-1)!;
    if (opensMethod(statement)) {
      scopes.push({ assigned: hasMethodParameter(statement, name) });
    } else if (opensNamespace(statement)) {
      scopes.push({ assigned: false });
    } else if (opensGemfileBlock(statement)) {
      scopes.push(statement.includes('do') ? { assigned: current.assigned } : current);
    }
    if (statement[0] === name && statement[1] === '=' && statement[2] !== '=') {
      current.assigned = true;
    }
  }
  return scopes.at(-1)!.assigned;
};

const opensNamespace = (tokens: string[]): boolean =>
  tokens.some((token, index) => (token === 'class' || token === 'module') &&
    (index === 0 || tokens[index - 1] === '='));

const opensMethod = (tokens: string[]): boolean =>
  tokens[0] === 'def' && !isEndlessMethod(tokens);

const hasMethodParameter = (tokens: string[], name: string): boolean => {
  const start = methodNameEnd(tokens);
  let depth = 0;
  let atParameter = true;
  for (const token of tokens.slice(start + Number(tokens[start] === '('))) {
    if (depth === 0) {
      if (token === ')') break;
      if (atParameter && (token === name || token === `${name}=`)) return true;
      atParameter = token === ',' || (atParameter && (token === '*' || token === '&'));
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
  }
  return false;
};

const methodNameEnd = (tokens: string[]): number => tokens[2] === '.' ? 4 : 2;

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = methodNameEnd(tokens);
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|=~|~|\?|:|\(|\[|,|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, interpolating = false) => {
  const opening = interpolating
    ? /\/|%([rQqWwIixs]?)([^a-zA-Z0-9\u0080-\uffff])/y
    : /\/|%(r)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const kind = match[1];
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    isRegexp: kind === undefined || kind === 'r',
    interpolates: !['q', 'w', 'i', 's'].includes(kind ?? ''),
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
  const regexpPart = /\\[\s\S]|#\{|[\s\S]/y;
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
      if (frames.length === 0) return content.slice(start, offset);
      continue;
    }
    const part = frame.braces === 0 ? regexpPart : expressionPart;
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
    } else if (!isComment(token) && !isSpacing(token)) {
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
