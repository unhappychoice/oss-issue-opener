import { expectsLiteral, readCharacter, readLiteral } from './gemfile-regexp.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const blockParameters = /\s*\|([\s\w,*&;()]+)\|/y;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const commandLocals = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token === 'do' || token === '{') {
      blockParameters.lastIndex = pattern.lastIndex;
      const parameters = blockParameters.exec(content)?.[1];
      parameters?.match(/\b[a-z_]\w*/g)?.forEach((name) => commandLocals.add(name));
    }
    if (token === '=' || token === '/' || token === '%' || token === '?') {
      const previous = previousSignificantToken(tokens, tokens.length - 1);
      const name = tokens[previous];
      const qualifier = tokens[previousSignificantToken(tokens, previous - 1)];
      if (token === '=') {
        if (isCommandName(name) && !['.', '@', '$'].includes(qualifier) && !/[=~]/.test(content[pattern.lastIndex] ?? '')) {
          commandLocals.add(name);
        }
      } else if (expectsLiteral(name ?? '\n', qualifier) ||
          (token === '/' && isCommandName(name) && canTakeCommandRegexp(name, qualifier, commandLocals) &&
            startsCommandRegexp(content, match.index))) {
        const literal = token === '?' ? readCharacter(content, match.index) : readLiteral(content, match.index, tokenPattern);
        if (literal) {
          pattern.lastIndex = match.index + literal.length;
          tokens.push(literal);
          continue;
        }
      }
    }
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token.startsWith('<<')) {
      if (opensSingletonClass(tokens, previousSignificantToken(tokens, tokens.length - 1))) {
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

const startsCommandRegexp = (content: string, start: number): boolean =>
  /[^\S\r\n]/.test(content[start - 1] ?? '') && /\S/.test(content[start + 1] ?? '');

const isCommandName = (token?: string): token is string => /^[A-Za-z_]\w*[!?]?$/.test(token ?? '');

const canTakeCommandRegexp = (name: string, qualifier: string | undefined, locals: Set<string>): boolean =>
  qualifier === '.' ||
  (!['@', '$'].includes(qualifier ?? '') && !locals.has(name) &&
    !/^(?:true|false|nil|self|__FILE__|__LINE__|__ENCODING__|end)$/.test(name));

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
