export const gemfileTokens = (content: string): string[] => {
  const pattern = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let regexpExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#')) continue;
    if (token === '/' && regexpExpected) {
      const literal = readRegexp(content, match.index);
      if (literal) {
        pattern.lastIndex = match.index + literal.length;
        tokens.push(literal);
        previous = literal;
        regexpExpected = false;
        classHeader = false;
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
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      regexpExpected = /^(?:\n|;|=|=>|~|\(|\[|,)$/.test(token) ||
        (previous !== '.' && /^(?:do|if|elsif|unless)$/.test(token));
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

const readRegexp = (content: string, start: number): string | undefined => {
  const regexpPart = /\\[\s\S]|#\{|\/[imxounes]*|[^/\\#]+|#/y;
  const expressionPart = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|#[^\n]*|[{}]|[^"'#{}]+/y;
  let offset = start + 1;
  let braces = 0;
  while (offset < content.length) {
    const part = braces === 0 ? regexpPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    offset = part.lastIndex;
    if (braces === 0) {
      if (match[0].startsWith('/')) return content.slice(start, offset);
      if (match[0] === '#{') braces++;
    } else {
      if (match[0] === '{') braces++;
      if (match[0] === '}') braces--;
    }
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
