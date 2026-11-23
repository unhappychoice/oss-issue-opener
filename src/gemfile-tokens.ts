export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      classHeader = false;
      previous = '<<';
      continue;
    }
    if ((token === '/' || token === '%') && expectsRegexp(previous)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('/regexp/');
        previous = '/regexp/';
        classHeader = false;
        continue;
      }
    }
    if (!isSpacing(token)) {
      classHeader = token === 'class' && /^(?:\n|;|do|\{|then|else|end|=|\(|,)$/.test(previous);
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const expectsRegexp = (previous: string): boolean =>
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|\?|:|&|\||if|elsif|unless|do|then|else)$/.test(previous);

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (type: string, opener: string) => ({
  opener,
  closer: pairedDelimiters.get(opener) ?? opener,
  interpolates: !/^[qwis]$/.test(type),
  regexp: type === 'r',
  depth: 1,
  braces: 0,
  previous: '{',
});

const regexpEnd = (content: string, start: number): number | undefined => {
  const regexpOpening = /\/|%r([^\p{L}\p{N}])/uy;
  regexpOpening.lastIndex = start;
  const initial = regexpOpening.exec(content);
  if (!initial) return undefined;

  const frames = [literalFrame('r', initial[1] ?? '/')];
  const literalPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'y');
  const percentOpening = /%([qQrwWiIxs]?)([^\p{L}\p{N}])/uy;
  const options = /[imxounes]*/y;
  let offset = regexpOpening.lastIndex;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closer && --frame.depth === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        offset += options.exec(content)![0].length;
      }
      frames.pop();
      if (!frames.length) return offset;
      continue;
    }

    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const token = part.exec(content)?.[0];
    if (token === undefined) return undefined;
    offset = part.lastIndex;
    if (frame.braces === 0) {
      if (frame.opener !== frame.closer && token === frame.opener) frame.depth++;
      if (frame.interpolates && token === '#' && content[offset] === '{') {
        offset++;
        frame.braces = 1;
        frame.previous = '{';
      }
      continue;
    }

    if (token.startsWith('#') || isSpacing(token)) continue;
    if (expectsRegexp(frame.previous)) {
      percentOpening.lastIndex = offset - token.length;
      const percent = token === '%' ? percentOpening.exec(content) : null;
      if (percent || token === '/') {
        frames.push(literalFrame(percent?.[1] ?? 'r', percent?.[2] ?? '/'));
        if (percent) offset = percentOpening.lastIndex;
        frame.previous = '/literal/';
        continue;
      }
    }
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.previous = token;
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
