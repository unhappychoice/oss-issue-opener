export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const commandRegexp = token === '/' && startsWarnRegexp(tokens, content[pattern.lastIndex]);
    if ((token === '/' || token === '%') && (commandRegexp || expectsExpression(tokens))) {
      const end = literalEnd(content, match.index);
      if (end !== undefined && (!commandRegexp || !/\w/.test(content[end] ?? ''))) {
        pattern.lastIndex = end;
        tokens.push(content.slice(match.index, end));
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const startsWarnRegexp = (tokens: string[], nextCharacter?: string): boolean => {
  if (!nextCharacter || /\s/.test(nextCharacter) || !/^[ \t]+$/.test(tokens.at(-1) ?? '')) return false;
  const index = previousTokenIndex(tokens);
  if (tokens[index] !== 'warn') return false;
  const before = tokens[previousTokenIndex(tokens, index - 1)] ?? '\n';
  return ['\n', ';', 'do'].includes(before);
};

const expectsExpression = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  const token = tokens[index] ?? '\n';
  return /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:)$/.test(token) ||
    (/^(?:!|do|if|elsif|unless|and|or)$/.test(token) && tokens[previousTokenIndex(tokens, index - 1)] !== '.');
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (opening: string, interpolates: boolean) => ({
  opening, closing: pairedDelimiters.get(opening) ?? opening, interpolates, depth: 1,
});

const literalEnd = (content: string, start: number): number | undefined => {
  const percentLiteral = /%([qQrwWiIxs])?([^a-zA-Z0-9\u0080-\uffff])/y;
  const slash = content[start] === '/';
  percentLiteral.lastIndex = start;
  const match = slash ? undefined : percentLiteral.exec(content);
  if (!slash && !match) return undefined;
  const isRegexp = slash || match?.[1] === 'r';
  const frames: (ReturnType<typeof literalFrame> | { tokens: string[]; depth: number })[] = [
    literalFrame(match?.[2] ?? '/', interpolatesPercentLiteral(match?.[1])),
  ];
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = slash ? start + 1 : percentLiteral.lastIndex;
  while (offset < content.length && frames.length) {
    const frame = frames.at(-1)!;
    const character = content[offset];
    if ('tokens' in frame) {
      percentLiteral.lastIndex = offset;
      const literal = expectsExpression(frame.tokens) && percentLiteral.exec(content);
      if (literal) {
        frames.push(literalFrame(literal[2], interpolatesPercentLiteral(literal[1])));
        frame.tokens.push(literal[0]);
        offset = percentLiteral.lastIndex;
        continue;
      }
      if (character === '/' && expectsExpression(frame.tokens)) {
        frames.push(literalFrame('/', true));
      } else {
        expression.lastIndex = offset;
        const token = expression.exec(content)?.[0];
        if (!token) return undefined;
        if (token === '{') frame.depth++;
        if (token === '}' && --frame.depth === 0) frames.pop();
        if (!token.startsWith('#')) frame.tokens.push(token);
        offset = expression.lastIndex;
        continue;
      }
      frame.tokens.push('/');
    } else if (character === frame.closing) {
      if (--frame.depth === 0) frames.pop();
    } else if (character === '\\') {
      offset++;
    } else if (frame.interpolates && content.startsWith('#{', offset)) {
      frames.push({ tokens: ['{'], depth: 1 });
      offset++;
    } else if (character === frame.opening) {
      frame.depth++;
    }
    offset++;
  }
  if (frames.length) return undefined;
  if (!isRegexp) return offset;
  options.lastIndex = offset;
  options.exec(content);
  return options.lastIndex;
};

const interpolatesPercentLiteral = (type?: string): boolean => !/^[qwis]$/.test(type ?? '');

const followsClassKeyword = (tokens: string[]): boolean => {
  let index = previousTokenIndex(tokens);
  if (tokens[index--] !== 'class') return false;
  index = previousTokenIndex(tokens, index);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
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
