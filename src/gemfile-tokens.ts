export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let regexpExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && regexpExpected) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        token = content.slice(match.index, end);
        pattern.lastIndex = end;
      }
    }
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      classHeader = false;
      previous = '<<';
      regexpExpected = false;
      continue;
    }
    if (!isSpacing(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
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

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|&&|\|\||!|~|\(|\[|\{|,|\?|:)$/.test(token) ||
  (token === 'if' && !['.', ':', '@', '$'].includes(previous));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const regexpOpening = /\/|%r([^\w\s])/y;
  regexpOpening.lastIndex = start;
  const root = regexpOpening.exec(content);
  if (!root) return undefined;

  const opening = /\/|%[rqQ]([^\w\s])/y;
  const expression = new RegExp(tokenPattern, 'y');
  const interpolated = /\\[\s\S]|#\{|[\s\S]/y;
  const plain = /\\[\s\S]|[\s\S]/y;
  const options = /[imxounes]*/y;
  const frames = [literalFrame(root[1] ? '%r' : '/', root[1] ?? '/')];
  let offset = regexpOpening.lastIndex;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    const part = frame.braces > 0 ? expression : frame.kind === '%q' ? plain : interpolated;
    part.lastIndex = offset;
    const token = part.exec(content)?.[0];
    if (!token) return undefined;
    offset = part.lastIndex;

    if (frame.braces === 0) {
      if (token === frame.closing && --frame.depth === 0) {
        frames.pop();
        if (frame.kind === '/' || frame.kind === '%r') {
          options.lastIndex = offset;
          options.exec(content);
          offset = options.lastIndex;
        }
        if (frames.length === 0) return offset;
      } else if (frame.delimiter !== frame.closing && token === frame.delimiter) {
        frame.depth++;
      } else if (token === '#{') {
        frame.braces = 1;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
      continue;
    }

    if (isSpacing(token) || token.startsWith('#')) continue;
    if ((token === '/' || token === '%') && frame.regexpExpected) {
      opening.lastIndex = offset - 1;
      const match = opening.exec(content);
      if (match) {
        frames.push(literalFrame(match[0].slice(0, match[1] ? 2 : 1), match[1] ?? '/'));
        offset = opening.lastIndex;
      }
    }
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.regexpExpected = expectsRegexp(token, frame.previous);
    frame.previous = token;
  }
  return undefined;
};

const literalFrame = (kind: string, delimiter: string) => ({
  kind,
  delimiter,
  closing: pairedDelimiters.get(delimiter) ?? delimiter,
  depth: 1,
  braces: 0,
  previous: '',
  regexpExpected: false,
});

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
