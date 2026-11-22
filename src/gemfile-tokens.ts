export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && expectsExpression(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('<regexp>');
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

const expectsExpression = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const token = tokens[index] ?? '\n';
  if (/^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|\+|&&|\|\|)$/.test(token)) return true;
  const preceding = tokens[previousSignificantToken(tokens, index - 1)];
  return /^(?:!|do|if|elsif|unless|when|return)$/.test(token) && !['.', '@', '$'].includes(preceding);
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation: boolean) => {
  const opener = /\/|%([rqQwWiIxs]?)([^\s\p{L}\p{N}])/uy;
  opener.lastIndex = start;
  const match = opener.exec(content);
  if (!match) return undefined;
  const regexp = match[0] === '/' || match[1] === 'r';
  if (!regexp && !inInterpolation) return undefined;
  const opening = match[2] ?? '/';
  return {
    opening,
    closing: pairedDelimiters.get(opening) ?? opening,
    end: opener.lastIndex,
    regexp,
    interpolates: regexp || !['q', 'w', 'i', 's'].includes(match[1]),
    nesting: 1,
    braces: 0,
    expression: [] as string[],
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start, false);
  if (!initial) return undefined;
  const frames = [initial];
  const body = /\\[\s\S]|#\{|[\s\S]/y;
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = initial.end;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (!frame.braces && content[offset] === frame.closing && --frame.nesting === 0) {
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
    const scanner = frame.braces ? expression : body;
    scanner.lastIndex = offset;
    const match = scanner.exec(content);
    if (!match) return undefined;
    const token = match[0];
    offset = scanner.lastIndex;
    if (!frame.braces) {
      if (frame.opening !== frame.closing && token === frame.opening) frame.nesting++;
      if (token === '#{' && frame.interpolates) {
        frame.braces = 1;
        frame.expression = [];
      }
      continue;
    }
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const nested = (token === '/' || token === '%') && expectsExpression(frame.expression)
      ? literalFrame(content, match.index, true)
      : undefined;
    if (nested) {
      frames.push(nested);
      frame.expression.push('<literal>');
      offset = nested.end;
      continue;
    }
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.expression.push(token);
  }
  return undefined;
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const classIndex = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[classIndex] !== 'class') return false;
  const preceding = tokens[previousSignificantToken(tokens, classIndex - 1)];
  return ['\n', ';', '=', 'do'].includes(preceding ?? '\n');
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

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
