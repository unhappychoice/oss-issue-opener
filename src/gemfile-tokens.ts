export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const assignedCommands = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const assignment = assignedRegexpCommand(tokens, token, content[pattern.lastIndex]);
    if (assignment) assignedCommands.add(assignment);
    if (((token === '/' || token === '%') && expectsExpression(tokens)) ||
      (token === '/' && expectsCommandRegexp(tokens, content[pattern.lastIndex], assignedCommands))) {
      const end = literalEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('<literal>');
        continue;
      }
    }
    if (token.startsWith('<<')) {
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const expectsExpression = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  const token = tokens[index] ?? '\n';
  if (/^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|\+|&&|\|\|)$/.test(token)) return true;
  const preceding = tokens[previousSignificantToken(tokens, index - 1)];
  return /^(?:!|and|or|do|if|elsif|unless|when|return)$/.test(token) && !['.', '@', '$'].includes(preceding);
};

const expectsCommandRegexp = (
  tokens: string[],
  nextCharacter: string | undefined,
  assignedCommands: ReadonlySet<string>,
): boolean => {
  if (!nextCharacter || /\s/.test(nextCharacter) || !isSpacing(tokens.at(-1) ?? '')) return false;
  const command = bareRegexpCommand(tokens);
  return command !== undefined && !assignedCommands.has(command);
};

const assignedRegexpCommand = (tokens: string[], token: string, next: string | undefined): string | undefined => {
  if (token === '=' && next !== '=' && next !== '~') return bareRegexpCommand(tokens);
  if ((token === 'warn=' || token === 'puts=') && followsStatementBoundary(tokens, tokens.length - 1)) {
    return token.slice(0, -1);
  }
  return undefined;
};

const bareRegexpCommand = (tokens: string[]): string | undefined => {
  const commandIndex = previousSignificantToken(tokens, tokens.length - 1);
  const command = tokens[commandIndex];
  if ((command === 'warn' || command === 'puts') && followsStatementBoundary(tokens, commandIndex - 1)) {
    return command;
  }
  return undefined;
};

const followsStatementBoundary = (tokens: string[], index: number): boolean =>
  ['\n', ';', 'do'].includes(tokens[previousSignificantToken(tokens, index)] ?? '\n');

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opener = /\/|%([rqQwWiIxs]?)([^\s\p{L}\p{N}])/uy;
  opener.lastIndex = start;
  const match = opener.exec(content);
  if (!match) return undefined;
  const regexp = match[0] === '/' || match[1] === 'r';
  const opening = match[2] ?? '/';
  return {
    opening,
    closing: pairedDelimiters.get(opening) ?? opening,
    end: opener.lastIndex,
    regexp,
    interpolates: regexp || !['q', 'w', 'i', 's'].includes(match[1]),
    nesting: 1,
    braces: 0,
    expression: [] as string[],
  };
};

const literalEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const body = /\\[\s\S]|[\s\S]/y;
  const interpolatedBody = /\\[\s\S]|#\{|[\s\S]/y;
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = initial.end;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (!frame.braces && content[offset] === frame.closing && --frame.nesting === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (!frames.length) return offset;
      continue;
    }
    const scanner = frame.braces ? expression : frame.interpolates ? interpolatedBody : body;
    scanner.lastIndex = offset;
    const match = scanner.exec(content);
    if (!match) return undefined;
    const token = match[0];
    offset = scanner.lastIndex;
    if (!frame.braces) {
      if (frame.opening !== frame.closing && token === frame.opening) frame.nesting++;
      if (token === '#{' && frame.interpolates) {
        frame.braces = 1;
        frame.expression = [];
      }
      continue;
    }
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const nested = (token === '/' || token === '%') && expectsExpression(frame.expression)
      ? literalFrame(content, match.index)
      : undefined;
    if (nested) {
      frames.push(nested);
      frame.expression.push('<literal>');
      offset = nested.end;
      continue;
    }
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.expression.push(token);
  }
  return undefined;
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const classIndex = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[classIndex] !== 'class') return false;
  const preceding = tokens[previousSignificantToken(tokens, classIndex - 1)];
  return ['\n', ';', '=', 'do'].includes(preceding ?? '\n');
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const previousSignificantToken = (tokens: string[], index: number): number => {
  while (index >= 0 && isSpacing(tokens[index])) index--;
  return index;
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
