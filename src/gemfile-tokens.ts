export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const rootLocals = new Set<string>();
  const scopes: { closer: string; locals: Set<string>; headerStart?: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const scope = scopes.at(-1);
    const locals = scope?.locals ?? rootLocals;
    const assignment = assignedRegexpCommand(tokens, token, content[pattern.lastIndex]);
    if (assignment) locals.add(assignment);
    if (((token === '/' || token === '%') && expectsExpression(tokens)) ||
      (token === '/' && expectsCommandRegexp(tokens, content[pattern.lastIndex], locals))) {
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
    const header = scope?.headerStart;
    const closesLoopHeader = token === 'do' && header !== undefined && tokens[header] !== 'def';
    const closer = closesLoopHeader ? undefined : scopeCloser(tokens, token);
    if (closer) {
      const block = token === 'do' || token === '{';
      const parameters = block ? blockParameters(content, pattern.lastIndex) : undefined;
      const scopedLocals = block ? new Set([...locals, ...(parameters?.names ?? [])]) :
        /^(?:class|module|def)$/.test(token) ? new Set<string>() : locals;
      const headerStart = /^(?:def|for|while|until)$/.test(token) ? { headerStart: tokens.length } : {};
      scopes.push({ closer, locals: scopedLocals, ...headerStart });
      if (parameters) pattern.lastIndex = parameters.end;
    } else if (token === scope?.closer) {
      scopes.pop();
    } else if (scope && header !== undefined && (closesLoopHeader || token === '\n' || token === ';')) {
      if (tokens[header] === 'def' && isEndlessMethod(tokens.slice(header).filter((part) => !isSpacing(part)))) {
        scopes.pop();
      }
      delete scope.headerStart;
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

export const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
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
  locals: ReadonlySet<string>,
): boolean => {
  if (!nextCharacter || /\s/.test(nextCharacter) || !isSpacing(tokens.at(-1) ?? '')) return false;
  const command = bareRegexpCommand(tokens);
  return command !== undefined && !locals.has(command);
};

const scopeCloser = (tokens: string[], token: string): string | undefined => {
  if (token === '{') return '}';
  const previous = tokens[previousSignificantToken(tokens, tokens.length - 1)];
  if (token === 'do' && !['.', ':', '@', '$'].includes(previous)) return 'end';
  const startsExpression = followsStatementBoundary(tokens, tokens.length - 1) || previous === '=';
  if (startsExpression && /^(?:class|module|def|if|unless|case|begin|while|until|for)$/.test(token)) return 'end';
  return undefined;
};

const blockParameters = (content: string, start: number) => {
  const opening = /[^\S\n]*\|\s*/y;
  opening.lastIndex = start;
  if (!opening.test(content)) return undefined;

  const names: string[] = [];
  const parameter = /\s*[*&]*(\w+)\s*/y;
  let offset = opening.lastIndex;
  while (content[offset] !== '|') {
    parameter.lastIndex = offset;
    const match = parameter.exec(content);
    if (!match) return undefined;
    names.push(match[1]);
    offset = parameter.lastIndex;
    if (content[offset] === '=') offset = blockDefaultEnd(content, offset + 1);
    if (content[offset] === '|') break;
    if (content[offset] !== ',' && content[offset] !== ';') return undefined;
    offset++;
  }
  return { names, end: offset + 1 };
};

const blockDefaultEnd = (content: string, start: number): number => {
  const scanner = new RegExp(tokenPattern, 'y');
  const tokens = ['='];
  let depth = 0;
  scanner.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(content)) !== null) {
    const token = match[0];
    if (depth === 0 && ['|', ',', ';', '\n'].includes(token)) return match.index;
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    const end = (token === '/' || token === '%') && expectsExpression(tokens)
      ? literalEnd(content, match.index)
      : undefined;
    if (end !== undefined) scanner.lastIndex = end;
    tokens.push(end === undefined ? token : '<literal>');
  }
  return content.length;
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
  ['\n', ';', 'do', '{'].includes(tokens[previousSignificantToken(tokens, index)] ?? '\n');

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
