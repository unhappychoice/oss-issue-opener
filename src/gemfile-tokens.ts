import { opensBlock, readStatements } from './gemfile-statements.js';

export const gemfileTokens = (content: string, onStatement?: (tokens: string[]) => void): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let operandExpected = true;
  const locals = trackWarnLocal(onStatement);
  const push = (token: string) => {
    tokens.push(token);
    locals.push(token);
  };
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = readToken(pattern, match, content, operandExpected);
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const warnRegexp = token === '/' && previous === 'warn' && !locals.isLocal() &&
      isSpacing(tokens.at(-1) ?? '') && /^[^\s=]/.test(content[pattern.lastIndex] ?? '');
    if (warnRegexp || (operandExpected && (token === '/' || token === '%'))) {
      const literal = readLiteral(content, match.index);
      if (literal) {
        pattern.lastIndex = match.index + literal.length;
        push(literal);
        previous = literal;
        operandExpected = false;
        continue;
      }
    }
    if (!isSpacing(token)) {
      if (token === 'warn' && previous !== '.' && assignsWarn(content, pattern.lastIndex)) locals.assign();
      operandExpected = expectsOperand(token, previous);
      previous = token;
    }
    if (token.startsWith('<<')) {
      if (opensSingletonClass(tokens)) {
        previous = '<<';
        push(previous);
        pattern.lastIndex = match.index + 2;
        continue;
      }
      const indented = /^<<[-~]/.test(token);
      const delimiter = token.slice(indented ? 3 : 2).replace(/^['"`]|['"`]$/g, '');
      pending.push({ delimiter, indented });
      push('""');
      continue;
    }
    push(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  locals.finish();
  return tokens;
};

const trackWarnLocal = (onStatement?: (tokens: string[]) => void) => {
  const scopes = [{ warn: false }];
  const blocks: boolean[] = [];
  const statements = readStatements((tokens) => {
    if (tokens[0] === 'end' && blocks.pop()) scopes.pop();
    const method = tokens[0] === 'def';
    if (opensBlock(tokens)) {
      blocks.push(method);
    } else if (method) {
      scopes.pop();
    }
    onStatement?.(tokens);
  }, (token) => {
    if (token === 'def') scopes.push({ warn: false });
  });
  return {
    ...statements,
    isLocal: () => scopes.at(-1)!.warn,
    assign: () => { scopes.at(-1)!.warn = true; },
  };
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const opensSingletonClass = (tokens: string[]): boolean => {
  const classIndex = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[classIndex] !== 'class') return false;
  const preceding = tokens[previousSignificantToken(tokens, classIndex - 1)];
  return ['\n', ';', '=', 'do'].includes(preceding ?? '\n');
};

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const assignsWarn = (content: string, offset: number): boolean => {
  const assignment = /[^\S\n]*(?:\|\||&&|\*\*|<<|>>|[+\-*/%&|^])?=(?![=>~])/y;
  assignment.lastIndex = offset;
  return assignment.test(content);
};

const previousSignificantToken = (tokens: string[], index: number): number => {
  while (index >= 0 && isSpacing(tokens[index])) index--;
  return index;
};

const readToken = (pattern: RegExp, match: RegExpExecArray, content: string, operandExpected: boolean): string => {
  if (match[0] !== '?' || !operandExpected) return match[0];
  const character = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  character.lastIndex = match.index;
  const literal = character.exec(content);
  if (!literal) return match[0];
  pattern.lastIndex = character.lastIndex;
  return literal[0];
};

const expectsOperand = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|,|&&|\|\||\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|and|or)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rqQwWiIs]?)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] === undefined || match[1] === 'r';
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp,
    interpolated: !/^[qwis]$/.test(match[1] ?? ''),
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    operandExpected: true,
  };
};

const readLiteral = (content: string, start: number): string | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|#\{|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'gy');
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.delimiters === 0) {
      offset++;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return content.slice(start, offset);
      continue;
    }
    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = frame.braces === 0 ? match[0] : readToken(part, match, content, frame.operandExpected);
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (frame.interpolated && token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.operandExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if ((token === '/' || token === '%') && frame.operandExpected) {
        const nested = literalFrame(content, offset);
        if (nested) {
          frames.push(nested);
          frame.previous = token;
          frame.operandExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.operandExpected = token === '{' || expectsOperand(token, frame.previous);
      frame.previous = token;
    }
    offset = part.lastIndex;
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
