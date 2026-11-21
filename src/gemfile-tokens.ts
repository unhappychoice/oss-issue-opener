import { canOpenLiteral, characterLiteralEnd, expectsRegexp, rubyLiteralEnd } from './gemfile-regexp.js';
import { hasGemfileBinding } from './gemfile-statements.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (canOpenLiteral(token)) {
      const index = previousSignificantToken(tokens, tokens.length - 1);
      const previousIndex = previousSignificantToken(tokens, index - 1);
      const previous = tokens[previousIndex];
      const commandRegexp = token === '/' && opensCommandRegexp(content, match.index, tokens, index, previousIndex);
      if (expectsRegexp(tokens[index], previous) || commandRegexp) {
        const end = token === '?'
          ? characterLiteralEnd(content, match.index)
          : rubyLiteralEnd(content, match.index, tokenPattern);
        if (end !== undefined) {
          tokens.push(content.slice(match.index, end));
          pattern.lastIndex = end;
          continue;
        }
      }
    }
    if (token.startsWith('<<') && token !== '<<=') {
      // A singleton class uses the shift token where the pattern can match a heredoc opener.
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|(?:&&|\|\||\*\*|<<|>>|[+\-*\/%&|^])=|&&|\|\||[^\S\n]+|\n|./;

const opensCommandRegexp = (
  content: string, start: number, tokens: string[], index: number, previousIndex: number,
): boolean => {
  const previous = tokens[previousIndex] ?? '\n';
  const command = tokens[index];
  return (command === 'warn' || command === 'puts' || command === 'print') && index < tokens.length - 1 &&
    /\S/.test(content[start + 1] ?? '') &&
    (previous === '.'
      ? tokens[previousSignificantToken(tokens, previousIndex - 1)] === 'Kernel'
      : ['\n', ';', 'do'].includes(previous) && !hasGemfileBinding(tokens.slice(0, index), command));
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[index] !== 'class') return false;
  const previous = tokens[previousSignificantToken(tokens, index - 1)] ?? '\n';
  return ['\n', ';', '=', 'do'].includes(previous);
};

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
