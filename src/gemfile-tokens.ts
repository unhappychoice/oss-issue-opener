import { gemfileStatements, opensBlock, opensNamespace } from './gemfile-scopes.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const previousIndex = previousTokenIndex(tokens);
    const literalEnd = regexpEnd(
      content, match.index, token, tokens[previousIndex], tokens[previousTokenIndex(tokens, previousIndex)],
      () => hasLocalWarn(tokens),
    );
    if (literalEnd !== undefined) {
      tokens.push(content.slice(match.index, literalEnd));
      pattern.lastIndex = literalEnd;
      continue;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|(?:@@?|\$)[A-Za-z_]\w*|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const expectsRegexp = (previous?: string, beforePrevious?: string): boolean =>
  previous === undefined || /^(?:\n|;|=|=>|~|[([{,:?+!]|&&|\|\|)$/.test(previous) ||
  (beforePrevious !== '.' && /^(?:do|if|elsif|unless)$/.test(previous));

const hasLocalWarn = (tokens: string[]): boolean => {
  let local = { hasWarn: false };
  const scopes: typeof local[] = [];
  gemfileStatements(tokens).forEach((statement) => {
    if (statement[0] === 'end') {
      local = scopes.pop() ?? local;
      return;
    }
    if (opensBlock(statement)) scopes.push(local);
    if (statement[0] === 'def') {
      local = { hasWarn: hasWarnParameter(statement) };
    } else if (opensNamespace(statement)) {
      local = { hasWarn: false };
    } else if (statement.some((token, index) => token === 'warn' && !isQualifiedName(statement[index - 1]) &&
      statement[index + 1] === '=' && !['=', '~'].includes(statement[index + 2]))) {
      local.hasWarn = true;
    }
  });
  return local.hasWarn;
};

const hasWarnParameter = (statement: string[]): boolean => {
  const parameters = statement.slice(isQualifiedName(statement[2]) ? 4 : 2);
  const start = parameters[0] === '(' ? 1 : 0;
  let depth = 0;
  return parameters.slice(start).some((token, index, tokens) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    if (depth !== 0 || token !== 'warn') return false;
    let previous = index - 1;
    while (['*', '&'].includes(tokens[previous])) previous--;
    return previous < 0 || tokens[previous] === ',';
  });
};

const isQualifiedName = (previous?: string): boolean =>
  previous === '.' || previous === ':';

const regexpEnd = (
  content: string, start: number, token: string, previous?: string, beforePrevious?: string, localWarn?: () => boolean,
): number | undefined => {
  if (token !== '/' && token !== '%') return undefined;
  const warnArgument = previous === 'warn' && token === '/' &&
    /[^\S\n]/.test(content[start - 1] ?? '') && /^[^\s=]$/.test(content[start + 1] ?? '') &&
    (isQualifiedName(beforePrevious) || !localWarn?.());
  if (!warnArgument && !expectsRegexp(previous, beforePrevious)) return undefined;
  const opening = /\/|%r([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalEnd = (
  content: string, start: number, opening: string, interpolates: boolean,
): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (char === '\\') {
      index++;
    } else if (char === closing) {
      if (--depth === 0) return index + 1;
    } else if (interpolates && char === '#' && content[index + 1] === '{') {
      const end = interpolationEnd(content, index + 2);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === opening) {
      depth++;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'gy');
  pattern.lastIndex = start;
  let depth = 1;
  let previous = '{';
  let beforePrevious: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin') || isTokenSpacing(token)) continue;
    const end = regexpEnd(content, match.index, token, previous, beforePrevious) ??
      (token === '%' && expectsRegexp(previous, beforePrevious) ? percentStringEnd(content, match.index) : undefined);
    beforePrevious = previous;
    if (end !== undefined) {
      pattern.lastIndex = end;
      previous = 'literal';
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    previous = token;
  }
  return undefined;
};

const percentStringEnd = (content: string, start: number): number | undefined => {
  const opening = /%([qQ]?)([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  return match ? literalEnd(content, opening.lastIndex, match[2], match[1] !== 'q') : undefined;
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
