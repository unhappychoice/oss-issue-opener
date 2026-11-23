export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && canStartRegexp(tokens)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
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
  let index = previousTokenIndex(tokens);
  if (tokens[index--] !== 'class') return false;
  index = previousTokenIndex(tokens, index);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
};

const canStartRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  const previous = tokens[index] ?? '\n';
  if (/^(?:\n|;|=|=>|&&|\|\||!|~|\(|\[|\{|,|\?|:)$/.test(previous)) return true;
  return /^(?:if|unless|elsif|while|until|case|when)$/.test(previous) &&
    tokens[previousTokenIndex(tokens, index - 1)] !== '.';
};

type Literal = { open: string; close: string; interpolates: boolean };

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const percentLiteral = (type: string, open: string): Literal => ({
  open,
  close: pairedDelimiters.get(open) ?? open,
  interpolates: !/[qwis]/.test(type),
});

const regexpEnd = (content: string, start: number): number | undefined => {
  const percent = /%r([^\w\s])/y;
  percent.lastIndex = start;
  const match = percent.exec(content);
  const literal = match ? percentLiteral('r', match[1]) : { open: '/', close: '/', interpolates: true };
  if (!match && content[start] !== '/') return undefined;
  const end = literalEnd(content, match ? percent.lastIndex : start + 1, literal);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const literalEnd = (content: string, start: number, literal: Literal): number | undefined => {
  const frames: (Literal | undefined)[] = [literal];
  for (let index = start; index < content.length; index++) {
    const frame = frames.at(-1);
    const char = content[index];
    if (char === '\\') index++;
    else if (!frame) index = scanInterpolation(content, index, frames);
    else if (char === frame.close) frames.pop();
    else if (char === frame.open) frames.push(frame);
    else if (frame.interpolates && char === '#' && content[index + 1] === '{') {
      frames.push(undefined);
      index++;
    }
    if (frames.length === 0) return index + 1;
  }
  return undefined;
};

const scanInterpolation = (content: string, index: number, frames: (Literal | undefined)[]): number => {
  const char = content[index];
  if (char === '{') frames.push(undefined);
  else if (char === '}') frames.pop();
  else if (char === '"' || char === "'" || char === '`') {
    frames.push({ open: char, close: char, interpolates: char !== "'" });
  } else if (char === '#') {
    const newline = content.indexOf('\n', index);
    return newline < 0 ? content.length : newline;
  } else if (char === '%') {
    const percent = /%([qQwWiIrxs])([^\w\s])/y;
    percent.lastIndex = index;
    const match = percent.exec(content);
    if (match) {
      frames.push(percentLiteral(match[1], match[2]));
      return percent.lastIndex - 1;
    }
  }
  return index;
};

const previousTokenIndex = (tokens: string[], index = tokens.length - 1): number => {
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
