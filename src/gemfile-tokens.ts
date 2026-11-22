import { opensGemfileLiteral, rubyLiteralEnd } from './gemfile-literals.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const locals = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const previous = previousSignificantToken(tokens, tokens.length - 1);
    const beforePrevious = previousSignificantToken(tokens, previous - 1);
    const prior = tokens[previous];
    const qualifier = tokens[beforePrevious];
    const next = content[match.index + 1] ?? '';
    if (token === '=' && !/[=~]/.test(next) && isBareName(prior, qualifier) && qualifier !== '.') {
      locals.add(prior);
    }
    const commandRegexp = token === '/' && previous < tokens.length - 1 && next !== '' && !/[\s=]/.test(next) &&
      isBareName(prior, qualifier) && (qualifier === '.' || !locals.has(prior));
    if (commandRegexp || opensGemfileLiteral(token, prior, qualifier)) {
      const end = rubyLiteralEnd(content, match.index, pattern);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
    }
    if (token.startsWith('<<')) {
      if (opensSingletonClass(tokens, previous)) {
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

const isBareName = (token?: string, qualifier?: string): token is string =>
  token !== undefined && /^[A-Za-z_]\w*[!?]?$/.test(token) &&
  !/^(?:true|false|nil|self|end|__FILE__|__LINE__|__ENCODING__)$/.test(token) &&
  !['@', '$', 'def'].includes(qualifier ?? '');

const opensSingletonClass = (tokens: string[], index: number): boolean =>
  tokens[index] === 'class' &&
  ['\n', ';', '=', 'do'].includes(tokens[previousSignificantToken(tokens, index - 1)] ?? '\n');

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
