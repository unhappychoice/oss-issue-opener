import { expectsLiteral, readCharacter, readLiteral } from './gemfile-regexp.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const blockParameters = /\s*\|([\s\w,*&;()]+)\|/y;
  const loopTargets = /[ \t]+((?:[a-z_]\w*[ \t]*,\s*)*[a-z_]\w*)[ \t]+in\b/y;
  const arrayPatternTargets = /[ \t]*\[\s*((?:[a-z_]\w*\s*,\s*)*[a-z_]\w*)\s*,?\s*\]/y;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const commandLocals = new Set<string>();
  const scopes: CommandScope[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    const scope = trackCommandScope(scopes, token, tokens);
    const localScopeIndex = currentLocalScopeIndex(scopes);
    const localScope = scopes[localScopeIndex];
    const locals = localScope?.parameters ?? commandLocals;
    if (scope?.method) {
      beginMethodHeader(scope, content, pattern.lastIndex);
    } else if (localScope?.header && match.index >= localScope.header.offset) {
      advanceMethodHeader(localScope, localScope.header, token, content, pattern.lastIndex);
    }
    const parameters = token === 'for' ? loopTargets :
      scope && !scope.method ? blockParameters : undefined;
    if (parameters) {
      parameters.lastIndex = pattern.lastIndex;
      parameters.exec(content)?.[1].match(/\b[a-z_]\w*/g)?.forEach((name) => (scope?.parameters ?? locals).add(name));
    }
    if (token === 'in' && scopes.at(-1)?.caseExpression &&
        ['\n', ';'].includes(tokens[previousSignificantToken(tokens, tokens.length - 1)])) {
      arrayPatternTargets.lastIndex = pattern.lastIndex;
      arrayPatternTargets.exec(content)?.[1].match(/\b[a-z_]\w*/g)?.forEach((name) => locals.add(name));
    }
    if (token === '=' || token === '/' || token === '%' || token === '?' || token === '`') {
      const previous = previousSignificantToken(tokens, tokens.length - 1);
      const name = tokens[previous];
      const qualifier = tokens[previousSignificantToken(tokens, previous - 1)];
      if (token === '=') {
        if (!/[=~]/.test(content[pattern.lastIndex] ?? '')) {
          recordAssignmentLocals(tokens, previous, locals);
        }
      } else if ((token === '`' && name !== '.' && name !== 'def') || expectsLiteral(name ?? '\n', qualifier) ||
          (token === '/' && isCommandName(name) && canTakeCommandRegexp(name, qualifier, locals, scopes.slice(localScopeIndex + 1)) &&
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
    if (token !== '<<' && token.startsWith('<<')) {
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

type MethodHeader = { offset: number; depth: number; parenthesized: boolean };

const beginMethodHeader = (scope: CommandScope, content: string, offset: number): void => {
  const name = /[ \t]+(?:[A-Za-z_]\w*\.)?(?:[A-Za-z_]\w*[!?]?(?:=(?=[ \t]*\())?|\[\]=?|<=>|===|==|!=|=~|!~|[<>][<>=]|\*\*|[+\-~!]@?|[*/%&|^<>`])/y;
  name.lastIndex = offset;
  if (!name.test(content)) return;

  const parameters = /[ \t]*(\()|[ \t]+(?=[*&]{0,2}[a-z_])/y;
  parameters.lastIndex = name.lastIndex;
  const match = parameters.exec(content);
  if (match) {
    scope.header = {
      offset: readMethodParameter(content, parameters.lastIndex, scope.parameters),
      depth: 0,
      parenthesized: match[1] === '(',
    };
  } else if (startsEndlessBody(content, name.lastIndex)) {
    scope.endlessDepth = 0;
  }
};

const startsEndlessBody = (content: string, offset: number): boolean => {
  const equals = /[ \t]*=/y;
  equals.lastIndex = offset;
  return equals.test(content);
};

const readMethodParameter = (content: string, offset: number, locals: Set<string>): number => {
  const parameter = /\s*(?:(\()|[*&]{0,2}([a-z_]\w*))/y;
  parameter.lastIndex = offset;
  const match = parameter.exec(content);
  if (!match) return offset;
  if (match[1]) return readDestructuredParameter(content, parameter.lastIndex, locals) ?? offset;
  locals.add(match[2]);
  return parameter.lastIndex;
};

const readDestructuredParameter = (content: string, offset: number, locals: Set<string>): number | undefined => {
  const binding = /\s*(?:#[^\n]*\s*)*(?:([a-z_]\w*)|([()])|[,*])/y;
  binding.lastIndex = offset;
  const names: string[] = [];
  let depth = 1;
  let match: RegExpExecArray | null;
  while (depth > 0 && (match = binding.exec(content)) !== null) {
    if (match[1]) names.push(match[1]);
    if (match[2] === '(') depth++;
    if (match[2] === ')') depth--;
  }
  if (depth !== 0) return undefined;
  names.forEach((name) => locals.add(name));
  return binding.lastIndex;
};

const advanceMethodHeader = (
  scope: CommandScope, header: MethodHeader, token: string, content: string, offset: number,
): void => {
  if (header.depth === 0) {
    if (token === ')' || (!header.parenthesized && (token === '\n' || token === ';'))) {
      delete scope.header;
      if (token === ')' && startsEndlessBody(content, offset)) scope.endlessDepth = 0;
      return;
    }
    if (token === ',') header.offset = readMethodParameter(content, offset, scope.parameters);
  }
  if (['(', '[', '{'].includes(token)) header.depth++;
  if ([')', ']', '}'].includes(token)) header.depth--;
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||(?:\*\*|<<|>>)(?==)|[^\S\n]+|\n|./;

const startsCommandRegexp = (content: string, start: number): boolean =>
  /[^\S\r\n]/.test(content[start - 1] ?? '') && /[^\s=]/.test(content[start + 1] ?? '');

const isCommandName = (token?: string): token is string => /^[A-Za-z_]\w*[!?]?$/.test(token ?? '');

const canTakeCommandRegexp = (
  name: string, qualifier: string | undefined, locals: Set<string>, scopes: CommandScope[],
): boolean =>
  qualifier === '.' ||
  (!['@', '$'].includes(qualifier ?? '') && !locals.has(name) && !scopes.some(({ parameters }) => parameters.has(name)) &&
    !/^(?:true|false|nil|self|__FILE__|__LINE__|__ENCODING__|end)$/.test(name));

type CommandScope = {
  closer: 'end' | '}';
  parameters: Set<string>;
  loopHeader?: boolean;
  caseExpression?: boolean;
  method?: boolean;
  header?: MethodHeader;
  endlessDepth?: number;
  namespaceHeaderDepth?: number;
  namespaceBody?: boolean;
};

const currentLocalScopeIndex = (scopes: CommandScope[]): number => {
  let index = scopes.length - 1;
  while (index >= 0 && !scopes[index].method && !scopes[index].namespaceBody) index--;
  return index;
};

const trackCommandScope = (scopes: CommandScope[], token: string, tokens: string[]): CommandScope | undefined => {
  if (!/^(?:do|end|[{};\n()\[\]]|class|module|def|if|unless|case|begin|while|until|for)$/.test(token)) return;
  const scope = scopes.at(-1);
  const previous = tokens[previousSignificantToken(tokens, tokens.length - 1)];
  if (previous === '.' || previous === '@' || previous === '$') return;
  if (scope?.namespaceHeaderDepth !== undefined) advanceNamespaceHeader(scope, scope.namespaceHeaderDepth, token, previous);
  if (scope?.endlessDepth !== undefined) {
    if (token === '(' || token === '[') scope.endlessDepth++;
    if (token === ')' || token === ']') scope.endlessDepth--;
    if (scope.endlessDepth === 0 && ['\n', ';'].includes(token)) scopes.pop();
  }
  if (scope?.closer === token) {
    scopes.pop();
  } else if (scope?.loopHeader && ['do', '\n', ';'].includes(token)) {
    scope.loopHeader = false;
  } else if (token === '{' || token === 'do') {
    const block: CommandScope = { closer: token === '{' ? '}' : 'end', parameters: new Set() };
    scopes.push(block);
    return block;
  } else if (/^(?:class|module|def|if|unless|case|begin|while|until|for)$/.test(token) &&
    ['\n', ';', '=', 'do', '{', '('].includes(previous ?? '\n')) {
    const block: CommandScope = {
      closer: 'end',
      parameters: new Set(),
      loopHeader: /^(?:while|until|for)$/.test(token),
      caseExpression: token === 'case',
      method: token === 'def',
    };
    if (token === 'class' || token === 'module') block.namespaceHeaderDepth = 0;
    scopes.push(block);
    if (block.method) return block;
  }
  return undefined;
};

const advanceNamespaceHeader = (scope: CommandScope, depth: number, token: string, previous?: string): void => {
  if (token === '(' || token === '[') scope.namespaceHeaderDepth = depth + 1;
  if (token === ')' || token === ']') scope.namespaceHeaderDepth = depth - 1;
  if (depth === 0 && (token === ';' || (token === '\n' && previous !== '<' && previous !== '<<'))) {
    delete scope.namespaceHeaderDepth;
    scope.namespaceBody = true;
  }
};

const opensSingletonClass = (tokens: string[], index: number): boolean =>
  tokens[index] === 'class' &&
  ['\n', ';', '=', 'do'].includes(tokens[previousSignificantToken(tokens, index - 1)] ?? '\n');

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const recordAssignmentLocals = (tokens: string[], previous: number, locals: Set<string>): void => {
  const compound = previous === tokens.length - 1 && /^(?:&&|\|\||\*\*|<<|>>|[-+*/%&|^])$/.test(tokens[previous] ?? '');
  const last = compound ? previousSignificantToken(tokens, previous - 1) : previous;
  const qualifier = tokens[previousSignificantToken(tokens, last - 1)];
  if (isCommandName(tokens[last]) && !['.', '@', '$'].includes(qualifier)) locals.add(tokens[last]);
  if (compound) return;

  const targets: string[] = [];
  const boundary = readAssignmentTargets(tokens, last, targets);
  if (boundary !== undefined && (boundary < 0 || ['\n', ';', 'do'].includes(tokens[boundary]))) {
    targets.forEach((target) => locals.add(target));
  }
};

const readAssignmentTargets = (tokens: string[], end: number, targets: string[]): number | undefined => {
  let target = tokens[end] === ',' ? previousSignificantToken(tokens, end - 1) : end;
  while (target >= 0) {
    const separator = readAssignmentTarget(tokens, target, targets);
    if (separator === undefined || tokens[separator] !== ',') return separator;
    target = previousSignificantToken(tokens, separator - 1);
  }
  return undefined;
};

const readAssignmentTarget = (tokens: string[], target: number, targets: string[]): number | undefined => {
  const token = tokens[target];
  if (token === ')') {
    let inner = previousSignificantToken(tokens, target - 1);
    while (tokens[inner] === '\n') inner = previousSignificantToken(tokens, inner - 1);
    const opening = readAssignmentTargets(tokens, inner, targets);
    return opening !== undefined && tokens[opening] === '(' ? assignmentSeparator(tokens, opening) : undefined;
  }
  if (token === '*') return assignmentSeparator(tokens, target);
  if (!isCommandName(token)) return undefined;
  const separator = assignmentSeparator(tokens, target);
  if (tokens[separator] === '@' || tokens[separator] === '$') {
    const prefix = tokens[separator] === '@' && tokens[separator - 1] === '@' ? separator - 1 : separator;
    return assignmentSeparator(tokens, prefix);
  }
  targets.push(token);
  return tokens[separator] === '*' ? assignmentSeparator(tokens, separator) : separator;
};

const assignmentSeparator = (tokens: string[], target: number): number => {
  const previous = previousSignificantToken(tokens, target - 1);
  let separator = previous;
  while (tokens[separator] === '\n') separator = previousSignificantToken(tokens, separator - 1);
  return [',', '('].includes(tokens[separator]) ? separator : previous;
};

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
