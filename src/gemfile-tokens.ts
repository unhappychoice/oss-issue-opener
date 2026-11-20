export const gemfileTokens = (content: string): string[] => {
  const pattern = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#')) continue;
    if ((token === '/' || token === '%') && /^(?:\n|;|=|=>|~|\(|\[|,|if|elsif|unless)$/.test(previous)) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push(content.slice(match.index, end));
        previous = token;
        classHeader = false;
        continue;
      }
    }
    if (token.startsWith('<<') && classHeader) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      classHeader = false;
      continue;
    }
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
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

const regexpDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;

  const delimiter = match[1] ?? '/';
  const closing = regexpDelimiters.get(delimiter) ?? delimiter;
  const parts = /\\[\s\S]|[\s\S]/y;
  parts.lastIndex = opening.lastIndex;
  let depth = 1;
  let part: RegExpExecArray | null;
  while ((part = parts.exec(content)) !== null) {
    if (delimiter !== closing && part[0] === delimiter) depth++;
    if (part[0] === closing && --depth === 0) {
      const options = /[imxounes]*/y;
      options.lastIndex = parts.lastIndex;
      options.exec(content);
      return options.lastIndex;
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
