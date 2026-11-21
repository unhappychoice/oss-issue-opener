import { opensLocalScope, opensScope, splitGemfileStatements } from './gemfile-scopes.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const putsAssignments = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const compoundAssignment = compoundAssignmentPattern.test(token);
    if (token === '=' || compoundAssignment || token === '/' || token === '%' || token === '?') {
      const index = previousSignificantToken(tokens, tokens.length - 1);
      const previous = tokens[index];
      const qualifier = tokens[previousSignificantToken(tokens, index - 1)];
      const barePuts = previous === 'puts' && !['.', ':', '@', '$'].includes(qualifier);
      if (token === '=' || compoundAssignment) {
        const assignsPuts = barePuts || (!compoundAssignment && assignsParallelPuts(tokens, index));
        if (assignsPuts && (compoundAssignment || !/^[=~]/.test(content[pattern.lastIndex] ?? '')) &&
          !declaresPutsParameter(tokens)) {
          putsAssignments.add(currentLocalScope(tokens).index);
        }
      } else if (expectsRegexp(previous, qualifier) ||
        (startsPutsRegexp(previous, qualifier, content, match.index) &&
          (!barePuts || !hasLocalPuts(tokens, putsAssignments)))) {
        const end = token === '?' ? characterLiteralEnd(content, match.index) : regexpEnd(content, match.index);
        if (end !== undefined) {
          tokens.push(content.slice(match.index, end));
          pattern.lastIndex = end;
          continue;
        }
      }
    }
    if (token.startsWith('<<') && !compoundAssignment) {
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

const compoundAssignmentPattern = /^(?:\|\||&&|\*\*|<<|>>|[+*/%&|^-])=$/;

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|(?:\|\||&&|\*\*|<<|>>|[+*/%&|^-])=|&&|\|\||[^\S\n]+|\n|./;

const expectsRegexp = (token = '\n', previous?: string): boolean =>
  compoundAssignmentPattern.test(token) || /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|case|when|return)$/.test(token));

const startsPutsRegexp = (
  previous: string | undefined, qualifier: string | undefined, content: string, start: number,
): boolean => {
  if (previous !== 'puts' || qualifier === '@' || qualifier === '$') return false;
  const argument = /[ \t](?:\/\S|%r)/y;
  argument.lastIndex = start - 1;
  return argument.test(content);
};

const characterLiteralEnd = (content: string, start: number): number | undefined => {
  const pattern = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  pattern.lastIndex = start;
  return pattern.test(content) ? pattern.lastIndex : undefined;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation: boolean) => {
  const opening = inInterpolation ? /\/|%([rQq])?([^a-zA-Z0-9\u0080-\uffff])/y : /\/|%(r)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    regexp: match[0] === '/' || match[1] === 'r',
    interpolates: match[1] !== 'q',
    depth: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start, false);
  if (!initial) return undefined;
  const frames = [initial];
  const expression = new RegExp(tokenPattern, 'y');
  const literal = /\\[\s\S]|#\{|[\s\S]/y;
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.depth === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces === 0 ? literal : expression;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.depth++;
      if (frame.interpolates && token === '#{') {
        frame.braces = 1;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if (frame.regexpExpected && token === '?') {
        const end = characterLiteralEnd(content, offset);
        if (end !== undefined) {
          frame.previous = content.slice(offset, end);
          frame.regexpExpected = false;
          offset = end;
          continue;
        }
      }
      const nested = frame.regexpExpected && (token === '/' || token === '%')
        ? literalFrame(content, offset, true)
        : undefined;
      if (nested) {
        frames.push(nested);
        frame.previous = token;
        frame.regexpExpected = false;
        offset = nested.start;
        continue;
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.regexpExpected = expectsRegexp(token, frame.previous);
      frame.previous = token;
    }
    offset = part.lastIndex;
  }
  return undefined;
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[index] !== 'class') return false;
  const previous = tokens[previousSignificantToken(tokens, index - 1)] ?? '\n';
  return ['\n', ';', '=', 'do'].includes(previous);
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const hasLocalPuts = (tokens: string[], assignments: Set<number>): boolean => {
  const { index, bindsPuts } = currentLocalScope(tokens);
  return bindsPuts || assignments.has(index);
};

const currentLocalScope = (tokens: string[]) => {
  const topLevel = { index: -1, bindsPuts: false };
  const scopes: (typeof topLevel)[] = [];
  splitGemfileStatements(tokens).forEach((statement, index) => {
    if (statement[0] === 'end') scopes.pop();
    const scope = scopes.at(-1) ?? topLevel;
    if (bindsForPuts(statement)) scope.bindsPuts = true;
    if (statement[0] === '|' && hasPutsParameter(statement.slice(1, -1))) {
      scopes[scopes.length - 1] = { ...scope, bindsPuts: true };
    }
    if (opensScope(statement)) {
      scopes.push(opensLocalScope(statement)
        ? { index, bindsPuts: declaresMethodPutsParameter(statement) }
        : opensBlockScope(statement) ? { ...scope } : scope);
    }
  });
  return scopes.at(-1) ?? topLevel;
};

const declaresPutsParameter = (tokens: string[]): boolean => {
  const statement = splitGemfileStatements(tokens).at(-1);
  return statement !== undefined && declaresMethodPutsParameter(statement);
};

const opensBlockScope = (statement: string[]): boolean =>
  statement.at(-1) === 'do' && !/^(?:for|until|while)$/.test(statement[0]);

const bindsForPuts = (statement: string[]): boolean => {
  if (statement[0] !== 'for') return false;
  const inIndex = statement.indexOf('in');
  if (inIndex < 0) return false;
  const targets = statement.slice(1, inIndex);
  return targets.some((token, index) => token === 'puts' &&
    (index === 0 || [',', '(', '*'].includes(targets[index - 1])) &&
    (index === targets.length - 1 || [',', ')'].includes(targets[index + 1])));
};

const declaresMethodPutsParameter = (statement: string[]): boolean => {
  if (statement[0] !== 'def') return false;
  const parameters = statement.slice(statement[2] === '.' ? 4 : 2);
  if (parameters[0] === '(') parameters.shift();
  return hasPutsParameter(parameters);
};

const hasPutsParameter = (parameters: string[]): boolean => {
  let depth = 0;
  let atParameterStart = true;
  for (const token of parameters) {
    if (atParameterStart && token === 'puts') return true;
    if (atParameterStart && ['*', '&'].includes(token)) continue;
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    atParameterStart = depth === 0 && (token === ',' || token === ';');
  }
  return false;
};

const assignsParallelPuts = (tokens: string[], end: number): boolean => {
  let boundary = end;
  while (boundary >= 0 && tokens[boundary] !== '\n' && tokens[boundary] !== ';') boundary--;
  const target = tokens.slice(boundary + 1, end + 1).filter((token) => !isSpacing(token)).join(' ');
  const match = /^(?:\( (\w+(?: , \w+)+) \)|(\w+(?: , \w+)+))$/.exec(target);
  return (match?.[1] ?? match?.[2] ?? '').split(' , ').includes('puts');
};

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
