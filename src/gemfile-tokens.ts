export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const localNames = new Set<string>();
  const scopes: ParameterScope[] = [];
  const assignment = /[ \t]*(?:&&|\|\||\*\*|<<|>>|[+*/%&|^\-])?=(?!=|>|~)/y;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '?' && content[pattern.lastIndex] === '/' && startsRegexp(tokens)) {
      tokens.push('?/');
      pattern.lastIndex++;
      continue;
    }
    if (nameToken.test(token)) {
      const name = token.replace(/=$/, '');
      assignment.lastIndex = match.index + name.length;
      const previous = tokens[previousTokenIndex(tokens)];
      if (!isQualifiedName(previous) && assignment.test(content) && !hasParameter(scopes, name)) localNames.add(name);
    }
    const slashArgument = token === '/' && startsCommandRegexp(content, match.index, tokens, localNames, scopes);
    if ((token === '/' || token === '%') && (slashArgument || startsRegexp(tokens))) {
      const literal = readRegexp(content, match.index);
      if (literal) {
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
    trackParameterScope(content, pattern.lastIndex, token, tokens, scopes, localNames);
    tokens.push(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  return tokens;
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&(?!=)|\|\|(?!=)|[^\S\n]+|\n|./;

const startsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  return expectsRegexp(tokens[index] ?? '\n', tokens[previousTokenIndex(tokens, index)]);
};

const nameToken = /^[A-Za-z_]\w*[!?=]?$/;

const isQualifiedName = (previous?: string): boolean => ['.', ':', '@', '$'].includes(previous ?? '');

type ParameterScope = { closing: 'end' | '}'; names?: string[]; loopHeader?: boolean } |
  { closing: 'statement'; names: string[]; bodyStart: number; loopHeader?: never };

const hasParameter = (scopes: ParameterScope[], name: string): boolean =>
  scopes.some(({ names }) => names?.includes(name));

const methodParameterScope = (content: string, offset: number): ParameterScope => {
  const methodName = /[ \t]+(?:\w+(?:::|\.))*\w+[!?=]?/y;
  methodName.lastIndex = offset;
  if (!methodName.test(content)) return { closing: 'end' };

  const signature = new RegExp(tokenPattern, 'gy');
  const names: string[] = [];
  signature.lastIndex = methodName.lastIndex;
  let token = signature.exec(content)?.[0];
  while (token && isTokenSpacing(token)) token = signature.exec(content)?.[0];
  const parenthesized = token === '(';
  if (parenthesized) token = signature.exec(content)?.[0];

  let depth = 0;
  let destructuring = 0;
  let expectsName = true;
  while (token) {
    const endsBareSignature = token === ';' || token === '\n' || (token === '=' && names.length === 0);
    if (depth === 0 && (parenthesized ? token === ')' : endsBareSignature)) break;
    if (token === '(' && expectsName && depth === destructuring) destructuring++;
    if ('([{'.includes(token)) depth++;
    if (')]}'.includes(token)) {
      depth--;
      destructuring = Math.min(depth, destructuring);
    }
    if (depth === destructuring && token === ',') expectsName = true;
    if (depth === destructuring && expectsName && /^[a-z_]\w*$/.test(token)) {
      names.push(token);
      expectsName = false;
    }
    token = signature.exec(content)?.[0];
  }

  const bodyStart = signature.lastIndex;
  return token === '=' || (parenthesized && token === ')' && /^[ \t]*=(?!=|>)/.test(content.slice(bodyStart)))
    ? { closing: 'statement', names, bodyStart }
    : { closing: 'end', names };
};

const trackParameterScope = (
  content: string, offset: number, token: string, tokens: string[], scopes: ParameterScope[],
  localNames: Set<string>,
): void => {
  if (!/^(?:end|\}|do|\{|class|module|def|if|unless|case|begin|while|until|for|\n|;)$/.test(token)) return;
  const previous = tokens[previousTokenIndex(tokens)];
  if (isQualifiedName(previous) || content[offset] === ':') return;
  const scope = scopes.at(-1);
  if (scope?.closing === token || (scope?.closing === 'statement' && offset > scope.bodyStart &&
    (token === '\n' || token === ';'))) {
    scopes.pop();
    return;
  }
  if (scope?.loopHeader && /^(?:do|\n|;)$/.test(token)) {
    scope.loopHeader = false;
    return;
  }
  if (token === 'do' || token === '{') {
    const parameters = /\s*\|((?:[*&]?[a-z_]\w*\b|[\s(),;])+)\|/y;
    parameters.lastIndex = offset;
    const names = parameters.exec(content)?.[1].match(/\w+/g) ?? [];
    scopes.push({ closing: token === 'do' ? 'end' : '}', names });
  } else if (/^(?:class|module|def|if|unless|case|begin|while|until|for)$/.test(token) &&
    (previous === undefined || /^(?:\n|;|=|do|\{|\(|\|)$/.test(previous))) {
    if (token === 'for') {
      const targets = /[ \t]+((?:[a-z_]\w*\b(?<!\bin)|[ \t(),*])+)[ \t]+in\b/y;
      targets.lastIndex = offset;
      targets.exec(content)?.[1].match(/\w+/g)?.forEach((name) => {
        if (!hasParameter(scopes, name)) localNames.add(name);
      });
    }
    scopes.push(token === 'def' ? methodParameterScope(content, offset) :
      { closing: 'end', loopHeader: /^(?:while|until|for)$/.test(token) });
  }
};

const startsCommandRegexp = (
  content: string, slash: number, tokens: string[], localNames: ReadonlySet<string>, scopes: ParameterScope[],
): boolean => {
  if (!/[ \t]/.test(content[slash - 1] ?? '') || /[\s=]/.test(content[slash + 1] ?? '')) return false;
  const index = previousTokenIndex(tokens);
  const name = tokens[index] ?? '';
  if (!nameToken.test(name) || name.endsWith('=')) return false;
  const previous = tokens[previousTokenIndex(tokens, index)];
  if (previous === '.') return true;
  return !isQualifiedName(previous) && !localNames.has(name) && !hasParameter(scopes, name) &&
    !/^(?:end|false|nil|self|true|__ENCODING__|__FILE__|__LINE__)$/.test(name);
};

const expectsRegexp = (token: string, previous?: string): boolean =>
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:if|elsif|unless|while|until|when|do)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation = false) => {
  const opening = inInterpolation ? /\/|%(r|[qQwWiIxs]?)([^\w\s])/y : /\/|%(r)([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  const kind = match[1] ?? 'r';
  return {
    delimiter,
    regexp: kind === 'r',
    interpolates: !/^[qwis]$/.test(kind),
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
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
  const interpolatedPart = /\\[\s\S]|#\{|[\s\S]/y;
  const literalPart = /\\[\s\S]|[\s\S]/y;
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
    const bodyPart = frame.interpolates ? interpolatedPart : literalPart;
    const part = frame.braces === 0 ? bodyPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (token === '#{') {
        frame.braces++;
        frame.previous = '{';
        frame.regexpExpected = true;
      }
    } else if (!token.startsWith('#') && !isTokenSpacing(token)) {
      if (token === '?' && content[part.lastIndex] === '/' && frame.regexpExpected) {
        frame.previous = '?/';
        frame.regexpExpected = false;
        offset = part.lastIndex + 1;
        continue;
      }
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
      frame.regexpExpected = expectsRegexp(token, frame.previous);
      frame.previous = token;
    }
    offset = part.lastIndex;
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
