export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./g;
  const regexp = /\/(?:\\[\s\S]|[^/\\])*\/[imxounes]*/y;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') && startsRegexp(tokens)) {
      regexp.lastIndex = match.index;
      const literal = token === '/'
        ? regexp.exec(content)?.[0]
        : percentRegexp(content, match.index);
      if (literal?.includes('\n')) {
        tokens.push(literal);
        pattern.lastIndex = match.index + literal.length;
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

const startsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  return index < 0 || /^(?:\n|;|=|=>|~|!|\(|\[|,|\?|:)$/.test(tokens[index]);
};

const percentRegexp = (content: string, start: number): string | undefined => {
  const opener = content[start + 2];
  if (content[start + 1] !== 'r' || !opener || /[\w\s]/.test(opener)) return;
  const pairedDelimiters: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
  const closer = pairedDelimiters[opener] ?? opener;
  let depth = 1;
  for (let index = start + 3; index < content.length; index++) {
    const character = content[index];
    if (character === '\\') {
      index++;
    } else if (character === closer && --depth === 0) {
      const options = content.slice(index + 1).match(/^[imxounes]*/)?.[0] ?? '';
      return content.slice(start, index + 1 + options.length);
    } else if (opener !== closer && character === opener) {
      depth++;
    }
  }
  return undefined;
};

const followsClassKeyword = (tokens: string[]): boolean => {
  const classIndex = previousTokenIndex(tokens);
  if (tokens[classIndex] !== 'class') return false;
  const index = previousTokenIndex(tokens, classIndex);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
};

const previousTokenIndex = (tokens: string[], before = tokens.length): number => {
  let index = before - 1;
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
