export const gemfileTokens = (content: string): string[] => {
  const pattern = tokenPattern();
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const commandLocals = commandLocalScopes(content);
  let previous = '\n';
  let regexpExpected = true;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = readToken(pattern, match, content, regexpExpected);
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const commandRegexp = token === '/' && isBareRegexpCommand(previous) &&
      !commandLocals.has(previous) && startsCommandRegexp(content, match.index, previous);
    if (((token === '/' || token === '%') && regexpExpected) || commandRegexp) {
      const literal = readRegexp(content, match.index);
      if (literal && (!commandRegexp || endsCommandRegexp(content, match.index + literal.length))) {
        pattern.lastIndex = match.index + literal.length;
        tokens.push(literal);
        previous = literal;
        regexpExpected = false;
        continue;
      }
    }
    if (!isTokenSpacing(token)) {
      commandLocals.track(token, previous, match.index, pattern.lastIndex);
      regexpExpected = expectsRegexp(token, previous);
      previous = token;
    }
    if (token.startsWith('<<')) {
      // In a singleton class header, << starts the receiver expression.
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

const isBareRegexpCommand = (token: string): boolean => token === 'warn' || token === 'puts';

const commandLocalScopes = (content: string) => {
  const locals = new Set<string>();
  const scopes: Set<string>[] = [];
  const assignment = /[^\S\n]*(?:\|\||&&|[+*/%&|^-])?=(?!=|>|~)/y;
  const targetList = /(\*?\w+[^\S\n]*,(?:\s*\*?\w+[^\S\n]*,)*(?:\s*\*?\w+)?)[^\S\n]*=(?!=|>|~)/y;
  const parameters = /\s*\|([^|]*)\|/y;
  let loopHeader = false;

  return {
    has: (name: string) => locals.has(name) || scopes.some((scope) => scope.has(name)),
    track(token: string, previous: string, start: number, offset: number) {
      const statementStart = previous === '\n' || previous === ';' || previous === 'do' || previous === '{';
      if (statementStart) {
        loopHeader = /^(?:while|until|for)$/.test(token);
        targetList.lastIndex = start;
        const targets = targetList.exec(content)?.[1].match(/\w+/g);
        targets?.filter(isBareRegexpCommand).forEach((name) => locals.add(name));
      }
      if (token === 'end' || token === '}') {
        scopes.pop();
      } else if (token === 'do' || token === '{') {
        if (token === 'do' && loopHeader) return;
        parameters.lastIndex = offset;
        const names = parameters.exec(content)?.[1].split(/[,;]/).map((parameter) =>
          parameter.trim().match(/^(?:[*&]+)?(\w+)/)?.[1] ?? '');
        scopes.push(new Set(names?.filter(isBareRegexpCommand)));
      } else if ((statementStart || previous === '=') &&
        /^(?:class|module|if|unless|case|begin|while|until|for)$/.test(token)) {
        scopes.push(new Set());
      } else if (isBareRegexpCommand(token) && !['.', ':', '@', '$'].includes(previous)) {
        assignment.lastIndex = offset;
        if (assignment.test(content)) locals.add(token);
      }
    },
  };
};

const startsCommandRegexp = (content: string, start: number, command: string): boolean => {
  const lineStart = Math.max(content.lastIndexOf('\n', start), content.lastIndexOf(';', start)) + 1;
  const prefix = content.slice(lineStart, start);
  return prefix.trim() === command && /[\t ]$/.test(prefix) && /^\S/.test(content.slice(start + 1, start + 2));
};

const endsCommandRegexp = (content: string, end: number): boolean => {
  // A later division slash can look like the closing delimiter of a bare argument.
  const boundary = /[^\S\n]*(?:[\n#,;)]|$)/y;
  boundary.lastIndex = end;
  return boundary.test(content);
};

const followsClassKeyword = (tokens: string[]): boolean => {
  let index = previousTokenIndex(tokens);
  if (tokens[index--] !== 'class') return false;
  index = previousTokenIndex(tokens, index);
  return index < 0 || ['\n', ';', 'do', '{', '=', '(', ','].includes(tokens[index]);
};

const previousTokenIndex = (tokens: string[], index = tokens.length - 1): number => {
  while (index >= 0 && isTokenSpacing(tokens[index])) index--;
  return index;
};

const isTokenSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const tokenPattern = () => /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;

const readToken = (pattern: RegExp, match: RegExpExecArray, content: string, operandExpected: boolean): string => {
  if (match[0] !== '?' || !operandExpected) return match[0];
  const character = /\?(?:\\[^\r\n]|[^\s\\])/uy;
  character.lastIndex = match.index;
  const literal = character.exec(content);
  if (!literal) return match[0];
  pattern.lastIndex = character.lastIndex;
  return literal[0];
};

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|,|&&|\|\||\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:!|not|do|if|elsif|unless|case|when)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation = false) => {
  const opening = /\/|%([rqQ]?)([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const regexp = match[1] === undefined || match[1] === 'r';
  if (!regexp && !inInterpolation) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    regexp,
    interpolated: match[1] !== 'q',
    start: opening.lastIndex,
    delimiters: 1,
    braces: 0,
    previous: '{',
    regexpExpected: true,
  };
};

const readRegexp = (content: string, start: number): string | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const regexpPart = /\\[\s\S]|#\{|[\s\S]/y;
  const expressionPart = tokenPattern();
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing) {
      offset++;
      if (--frame.delimiters > 0) continue;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return content.slice(start, offset);
      continue;
    }
    const part = frame.braces === 0 ? regexpPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (match?.index !== offset) return undefined;
    const token = frame.braces === 0 ? match[0] : readToken(part, match, content, frame.regexpExpected);
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (frame.interpolated && token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !token.startsWith('=begin') && !isTokenSpacing(token)) {
      if ((token === '/' || token === '%') && frame.regexpExpected) {
        const nested = literalFrame(content, offset, true);
        if (nested) {
          frames.push(nested);
          frame.previous = token;
          frame.regexpExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.regexpExpected = token === '{' || expectsRegexp(token, frame.previous);
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
