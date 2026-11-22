export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const scopes: LocalScope[] = [{ close: 'root', names: new Set() }];
  const assignment = /[^\S\n]*(?:(?:,[^\S\n]*[a-z_]\w*[^\S\n]*)*,?[^\S\n]*=(?!=|>|~)|(?:\|\||&&|\*\*|<<|>>|[+\-*/%&|^])=)/y;
  const blockParameters = /\s*\|([a-z_\w\s,;*&]*)\|/y;
  let previous = '\n';
  let previousIsLocal = false;
  let literalExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (startsLiteral(content, match.index, token, previous, literalExpected, !previousIsLocal)) {
      const end = literalEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push('literal');
        previous = 'literal';
        previousIsLocal = false;
        literalExpected = false;
        classHeader = false;
        continue;
      }
    }
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      previousIsLocal = false;
      literalExpected = false;
      classHeader = false;
      continue;
    }
    if (!isSpacing(token)) {
      const namespace = isScopeStart(previous) && /^(?:class|module)$/.test(token);
      classHeader = namespace && token === 'class';
      const method = token === 'def' && isScopeStart(previous)
        ? methodScope(content, pattern.lastIndex)
        : undefined;
      blockParameters.lastIndex = pattern.lastIndex;
      const parameters = /^(?:do|\{)$/.test(token) && previous !== '.'
        ? blockParameters.exec(content)?.[1]?.match(/[a-z_]\w*/g) ?? undefined
        : undefined;
      trackLocalScope(scopes, token, previous, literalExpected, namespace, method, parameters);
      const names = visibleLocalScopes(scopes);
      if (previous !== '.' && /^[a-z_]\w*$/.test(token)) {
        assignment.lastIndex = pattern.lastIndex;
        if (assignment.test(content)) names[0]?.add(token);
      }
      previousIsLocal = previous !== '.' && names.some((locals) => locals.has(token));
      literalExpected = expectsLiteral(token, previous);
      previous = token;
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|(?:@@?|\$)[A-Za-z_]\w*|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

type LocalScope = {
  close: 'root' | 'end' | '}' | ')' | ']' | 'statement';
  names?: Set<string>;
  isolated?: boolean;
  namespaceHeader?: boolean;
  loopHeader?: boolean;
};

const isScopeStart = (previous: string): boolean => /^(?:\n|;|do|\{|then|else|end|=|\(|,)$/.test(previous);

const trackLocalScope = (
  scopes: LocalScope[],
  token: string,
  previous: string,
  literalExpected: boolean,
  namespace: boolean,
  method: LocalScope | undefined,
  parameters: string[] | undefined,
): void => {
  const scope = scopes.at(-1)!;
  const statementEnd = token === '\n' || token === ';';
  const closesScope = scope.close === 'statement' ? statementEnd :
    scope.close !== 'root' && token === scope.close && previous !== '.';
  if (closesScope) {
    scopes.pop();
  } else if (method) {
    scopes.push(method);
  } else if (namespace) {
    scopes.push({ close: 'end', namespaceHeader: true });
  } else if (isScopeStart(previous) && /^(?:if|unless|case|begin|while|until|for)$/.test(token)) {
    scopes.push({ close: 'end', loopHeader: /^(?:while|until|for)$/.test(token) });
  } else if (token === 'do' && previous !== '.') {
    if (!scope.loopHeader) scopes.push({ close: 'end', names: new Set(parameters) });
    scope.loopHeader = false;
  } else if (token === '{') {
    scopes.push(literalExpected && !parameters ? { close: '}' } : { close: '}', names: new Set(parameters) });
  } else if (token === '(' || token === '[') {
    scopes.push({ close: token === '(' ? ')' : ']' });
  } else if (statementEnd) {
    scope.loopHeader = false;
    if (scope.namespaceHeader) {
      scope.namespaceHeader = false;
      scope.names = new Set();
      scope.isolated = true;
    }
  }
};

const visibleLocalScopes = (scopes: LocalScope[]): Set<string>[] => {
  const visible: Set<string>[] = [];
  for (let index = scopes.length - 1; index >= 0; index--) {
    const scope = scopes[index]!;
    if (scope.names) visible.push(scope.names);
    if (scope.isolated) break;
  }
  return visible;
};

const methodScope = (content: string, offset: number): LocalScope => {
  const signature = /[^\S\n]+(?:\w+(?:::|\.))*\w+[!?]?(?:=(?=[^\S\n]*\())?(?:[^\S\n]*\(([^)]*)\)|[^\S\n]+([^\s=][^;\n]*))?/y;
  signature.lastIndex = offset;
  const match = signature.exec(content);
  const parameters = match?.[1] ?? match?.[2] ?? '';
  const names = Array.from(
    parameters.matchAll(/(?:^|,)\s*(?:\*{1,2}|&)?([a-z_]\w*)\s*(?=[,:=]|$)/g),
    ([, name]) => name!,
  );
  const body = /[^\S\n]*=(?!=|>|~)/y;
  body.lastIndex = signature.lastIndex;
  const endless = match !== null && body.test(content);
  return { close: endless ? 'statement' : 'end', names: new Set(names), isolated: true };
};

const expectsLiteral = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|when|return|then)$/.test(token));

const startsLiteral = (
  content: string,
  offset: number,
  token: string,
  previous: string,
  expected: boolean,
  allowsBareCommand = false,
): boolean => {
  if (token !== '/') return token === '%' && expected;
  const command = /^[A-Za-z_]\w*[!?]$/.test(previous) ||
    (allowsBareCommand && /^[a-z_]\w*$/.test(previous));
  return expected || (
    command &&
    /\s/.test(content[offset - 1] ?? '') &&
    /[^\s=]/.test(content[offset + 1] ?? '')
  );
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number) => {
  const opening = /\/|%([rQqWwIisx]?)([^\s\p{L}\p{N}])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    regexp: match[1] === undefined || match[1] === 'r',
    interpolates: !/^[qwis]$/.test(match[1] ?? ''),
    delimiters: 1,
    braces: 0,
    previous: '{',
    literalExpected: true,
  };
};

const literalEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start);
  if (!initial) return undefined;
  const frames = [initial];
  const literalPart = /\\[\s\S]|[\s\S]/y;
  const expressionPart = new RegExp(tokenPattern, 'y');
  const flags = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    if (frame.braces === 0 && content[offset] === frame.closing && --frame.delimiters === 0) {
      offset++;
      if (frame.regexp) {
        flags.lastIndex = offset;
        flags.exec(content);
        offset = flags.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
      continue;
    }
    const part = frame.braces === 0 ? literalPart : expressionPart;
    part.lastIndex = offset;
    const match = part.exec(content);
    if (!match) return undefined;
    const token = match[0];
    if (frame.braces === 0) {
      if (frame.delimiter !== frame.closing && token === frame.delimiter) frame.delimiters++;
      if (frame.interpolates && token === '#' && content[part.lastIndex] === '{') {
        part.lastIndex++;
        frame.braces = 1;
        frame.previous = '{';
        frame.literalExpected = true;
      }
    } else if (!token.startsWith('#') && !isSpacing(token)) {
      if (startsLiteral(content, offset, token, frame.previous, frame.literalExpected)) {
        const nested = literalFrame(content, offset);
        if (nested) {
          frames.push(nested);
          frame.previous = 'literal';
          frame.literalExpected = false;
          offset = nested.start;
          continue;
        }
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      frame.literalExpected = expectsLiteral(token, frame.previous);
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
