export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const commandArgument = /[ \t]+\/(?=\S)/y;
  const localBinding = /[ \t]*(?:[,)|]|=(?!=|>|~))/y;
  const boundCommands = new Set<string>();
  let previous = '\n';
  let classHeader = false;
  let commandSlash = -1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const literal = literalEnd(content, match.index, token, previous, match.index === commandSlash);
    if (literal !== undefined) {
      pattern.lastIndex = literal;
      previous = content.slice(match.index, literal);
      tokens.push(previous);
      classHeader = false;
      continue;
    }
    const singletonClass = classHeader && token.startsWith('<<');
    if (!isSpacing(token)) {
      if ((token === 'warn' || token === 'puts') && previous !== '.') {
        // A possible local binding makes the bare command form ambiguous.
        localBinding.lastIndex = pattern.lastIndex;
        if (localBinding.test(content)) boundCommands.add(token);
        commandArgument.lastIndex = pattern.lastIndex;
        if (!boundCommands.has(token) && /^(?:\n|;|do)$/.test(previous) && commandArgument.test(content)) {
          commandSlash = commandArgument.lastIndex - 1;
        }
      }
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      previous = regexpContext(token, previous);
    }
    if (singletonClass) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      continue;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const expressionStart = /^(?:\n|;|=|=>|~|\(|\[|\{|,|&&|\|\||\?|:|!|do|if|elsif|unless|when)$/;
const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpContext = (token: string, previous: string): string =>
  previous === '.' && /^(?:do|if|elsif|unless|when)$/.test(token) ? `.${token}` : token;

const literalEnd = (
  content: string,
  start: number,
  token: string,
  previous: string,
  commandArgument = false,
): number | undefined => {
  if ((token !== '/' && token !== '%') || (!commandArgument && !expressionStart.test(previous))) return undefined;
  const opening = /\/|%([qQwWiIxrs]?)([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = delimitedEnd(content, opening.lastIndex, match[2] ?? '/', !/[qwis]/.test(match[1] ?? ''));
  if (token === '%' && match[1] !== 'r') return end;
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const delimitedEnd = (content: string, start: number, opening: string, interpolated: boolean): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  let offset = start;
  while (offset < content.length) {
    const char = content[offset++];
    if (char === closing && --depth === 0) return offset;
    if (char === '\\') offset++;
    if (char === opening && opening !== closing) depth++;
    if (interpolated && char === '#' && content[offset] === '{') {
      const end = interpolationEnd(content, offset + 1);
      if (end === undefined) return undefined;
      offset = end;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'y');
  pattern.lastIndex = start;
  let depth = 1;
  let previous = '{';
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (isSpacing(token) || token.startsWith('#')) continue;
    const literal = literalEnd(content, match.index, token, previous);
    if (literal !== undefined) {
      pattern.lastIndex = literal;
      previous = 'literal';
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    previous = regexpContext(token, previous);
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
