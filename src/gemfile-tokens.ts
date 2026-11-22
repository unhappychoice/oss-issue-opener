export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const locals = new Set<string>();
  const assignment = /([a-z_]\w*(?:[\t ]*,[\t ]*[a-z_]\w*)*)[\t ]*(?:\|\|=|&&=|[-+*/%&|^]=|=(?![=~>]))/y;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const previous = previousSignificantToken(tokens, tokens.length - 1);
    if (bareIdentifier.test(token) && atStatementStart(tokens[previous])) {
      assignment.lastIndex = match.index;
      assignment.exec(content)?.[1].split(/[\t ]*,[\t ]*/).forEach((name) => locals.add(name));
    }
    if (token === '/' || token === '%') {
      const preceding = tokens[previousSignificantToken(tokens, previous - 1)];
      if (expectsRegexp(tokens[previous], preceding) ||
        (token === '/' && isCommandRegexp(content, match.index, tokens, previous, preceding, locals))) {
        const end = regexpEnd(content, match.index);
        if (end !== undefined) {
          tokens.push(content.slice(match.index, end));
          pattern.lastIndex = end;
          continue;
        }
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./;

const bareIdentifier = /^[a-z_]\w*[!?]?$/;
const atStatementStart = (previous = '\n'): boolean => ['\n', ';', 'do'].includes(previous);

const isCommandRegexp = (
  content: string, start: number, tokens: string[], previous: number, preceding: string, locals: Set<string>,
): boolean => {
  const name = tokens[previous];
  return atStatementStart(preceding) && bareIdentifier.test(name) && !locals.has(name) &&
    !/^(?:end|true|false|nil|self|__FILE__|__LINE__|__ENCODING__)$/.test(name) &&
    /^[\t ]+$/.test(tokens.at(-1) ?? '') && /^[^\s=]/.test(content[start + 1] ?? '');
};

const expectsRegexp = (previous = '\n', preceding?: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&|\|)$/.test(previous) ||
  (preceding !== '.' && /^(?:!|do|if|elsif|unless|when|then|else|return)$/.test(previous));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);
const regexpOpening = /\/|%r([^\p{L}\p{N}\s])/uy;
const percentStringOpening = /%([qQ]?)([^\p{L}\p{N}\s])/uy;

const literalFrame = (delimiter: string, interpolates: boolean, regexp: boolean) => ({
  delimiter,
  closing: pairedDelimiters.get(delimiter) ?? delimiter,
  interpolates,
  regexp,
  delimiters: 1,
  braces: 0,
  previous: '{',
  preceding: undefined as string | undefined,
});

const regexpEnd = (content: string, start: number): number | undefined => {
  regexpOpening.lastIndex = start;
  const opening = regexpOpening.exec(content);
  if (!opening) return undefined;
  const frames = [literalFrame(opening[1] ?? '/', true, true)];
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = regexpOpening.lastIndex;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces > 0) {
      expression.lastIndex = offset;
      const match = expression.exec(content);
      if (!match) return undefined;
      offset = interpolationToken(content, match, expression.lastIndex, frames, frame);
      continue;
    }
    const char = content[offset++];
    if (char === frame.closing && --frame.delimiters === 0) {
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
    } else if (char === frame.delimiter && frame.delimiter !== frame.closing) {
      frame.delimiters++;
    } else if (char === '\\') {
      offset++;
    } else if (frame.interpolates && char === '#' && content[offset] === '{') {
      frame.braces = 1;
      frame.previous = '{';
      frame.preceding = undefined;
      offset++;
    }
  }
  return undefined;
};

type LiteralFrame = ReturnType<typeof literalFrame>;

const interpolationToken = (
  content: string, match: RegExpExecArray, end: number, frames: LiteralFrame[], frame: LiteralFrame,
): number => {
  const token = match[0];
  if (isSpacing(token) || token.startsWith('#') || token.startsWith('=begin')) return end;
  if (token === '{') frame.braces++;
  if (token === '}') frame.braces--;
  const nested = (token === '/' || token === '%') && expectsRegexp(frame.previous, frame.preceding);
  frame.preceding = frame.previous;
  frame.previous = token;
  if (!nested) return end;

  regexpOpening.lastIndex = match.index;
  const regexp = regexpOpening.exec(content);
  if (regexp) {
    frames.push(literalFrame(regexp[1] ?? '/', true, true));
    return regexpOpening.lastIndex;
  }
  percentStringOpening.lastIndex = match.index;
  const string = percentStringOpening.exec(content);
  if (!string) return end;
  frames.push(literalFrame(string[2], string[1] !== 'q', false));
  return percentStringOpening.lastIndex;
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
