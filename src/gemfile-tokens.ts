export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && expectsRegexp(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

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

const expectsRegexp = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const token = tokens[index] ?? '\n';
  return /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:|[+*^&|<>%-])$/.test(token) ||
    (/^(?:!|do|if|elsif|unless|when|return)$/.test(token) &&
      tokens[previousSignificantToken(tokens, index - 1)] !== '.');
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, opening: RegExp) => {
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    regexp: match[1] === undefined || match[1] === 'r',
    interpolates: match[1] !== 'q',
    nesting: 1,
    braces: 0,
    expression: [] as string[],
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start, /\/|%(r)([^\w\s\u0080-\uffff])/y);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|#\{|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'y');
  const nestedOpening = /\/|%([rqQ]?)([^\w\s\u0080-\uffff])/y;
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
      if (!frames.length) return offset;
      continue;
    }
    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const token = part.exec(content)?.[0];
    if (token === undefined) return undefined;
    if (frame.braces === 0) {
      if (frame.interpolates && token === '#{') {
        frame.braces = 1;
        frame.expression = ['{'];
      } else if (frame.delimiter !== frame.closing && token === frame.delimiter) {
        frame.nesting++;
      }
    } else if (!token.startsWith('#')) {
      const nested = (token === '/' || token === '%') && expectsRegexp(frame.expression)
        ? literalFrame(content, offset, nestedOpening)
        : undefined;
      if (nested) {
        frames.push(nested);
        frame.expression.push('literal');
        offset = nested.start;
        continue;
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.expression.push(token);
    }
    offset = part.lastIndex;
  }
  return undefined;
};
