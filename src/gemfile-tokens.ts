import { expectsLiteral, readCharacter, readLiteral } from './gemfile-regexp.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const blockParameters = /\s*\|([\s\w,*&;()]+)\|/y;
  const loopTargets = /[ \t]+((?:[a-z_]\w*[ \t]*,\s*)*[a-z_]\w*)[ \t]+in\b/y;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const commandLocals = new Set<string>();
  const scopes: CommandScope[] = [];
  let methodHeader: MethodHeader | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    const scope = trackCommandScope(scopes, token, tokens);
    if (token === 'def') {
      methodHeader = readMethodHeader(content, pattern.lastIndex, commandLocals);
    } else if (methodHeader && match.index >= methodHeader.offset) {
      methodHeader = advanceMethodHeader(methodHeader, token, content, pattern.lastIndex, commandLocals);
    }
    const parameters = token === 'for' ? loopTargets :
      scope ? blockParameters : undefined;
    if (parameters) {
      parameters.lastIndex = pattern.lastIndex;
      parameters.exec(content)?.[1].match(/\b[a-z_]\w*/g)?.forEach((name) => (scope ?? commandLocals).add(name));
    }
    if (token === '=' || token === '/' || token === '%' || token === '?') {
      const previous = previousSignificantToken(tokens, tokens.length - 1);
      const name = tokens[previous];
      const qualifier = tokens[previousSignificantToken(tokens, previous - 1)];
      if (token === '=') {
        if (!/[=~]/.test(content[pattern.lastIndex] ?? '')) {
          recordAssignmentLocals(tokens, previous, commandLocals);
        }
      } else if (expectsLiteral(name ?? '\n', qualifier) ||
          (token === '/' && isCommandName(name) && canTakeCommandRegexp(name, qualifier, commandLocals, scopes) &&
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

const readMethodHeader = (content: string, offset: number, locals: Set<string>): MethodHeader | undefined => {
  const header = /[ \t]+(?:[A-Za-z_]\w*\.)?[A-Za-z_]\w*[!?=]?(?:[ \t]*(\()|[ \t]+(?=[*&]{0,2}[a-z_]))/y;
  header.lastIndex = offset;
  const match = header.exec(content);
  if (!match) return undefined;
  return {
    offset: readMethodParameter(content, header.lastIndex, locals),
    depth: 0,
    parenthesized: match[1] === '(',
  };
};

const readMethodParameter = (content: string, offset: number, locals: Set<string>): number => {
  const parameter = /\s*[*&]{0,2}([a-z_]\w*)/y;
  parameter.lastIndex = offset;
  const match = parameter.exec(content);
  if (!match) return offset;
  locals.add(match[1]);
  return parameter.lastIndex;
};

const advanceMethodHeader = (
  header: MethodHeader, token: string, content: string, offset: number, locals: Set<string>,
): MethodHeader | undefined => {
  if (header.depth === 0) {
    if (token === ')' || (!header.parenthesized && (token === '\n' || token === ';'))) return undefined;
    if (token === ',') header.offset = readMethodParameter(content, offset, locals);
  }
  if (['(', '[', '{'].includes(token)) header.depth++;
  if ([')', ']', '}'].includes(token)) header.depth--;
  return header;
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

type CommandScope = { closer: 'end' | '}'; parameters: Set<string>; loopHeader?: boolean };

const trackCommandScope = (scopes: CommandScope[], token: string, tokens: string[]): Set<string> | undefined => {
  if (!/^(?:do|end|[{};\n]|class|module|def|if|unless|case|begin|while|until|for)$/.test(token)) return;
  const scope = scopes.at(-1);
  const previous = tokens[previousSignificantToken(tokens, tokens.length - 1)];
  if (previous === '.' || previous === '@' || previous === '$') return;
  if (scope?.closer === token) {
    scopes.pop();
  } else if (scope?.loopHeader && ['do', '\n', ';'].includes(token)) {
    scope.loopHeader = false;
  } else if (token === '{' || token === 'do') {
    const parameters = new Set<string>();
    scopes.push({ closer: token === '{' ? '}' : 'end', parameters });
    return parameters;
  } else if (/^(?:class|module|def|if|unless|case|begin|while|until|for)$/.test(token) &&
    ['\n', ';', '=', 'do', '{', '('].includes(previous ?? '\n')) {
    scopes.push({ closer: 'end', parameters: new Set(), loopHeader: /^(?:while|until|for)$/.test(token) });
  }
  return undefined;
};

const opensSingletonClass = (tokens: string[], index: number): boolean =>
  tokens[index] === 'class' &&
  ['\n', ';', '=', 'do'].includes(tokens[previousSignificantToken(tokens, index - 1)] ?? '\n');

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const recordAssignmentLocals = (tokens: string[], previous: number, locals: Set<string>): void => {
  const compound = previous === tokens.length - 1 && /^(?:&&|\|\||\*\*|<<|>>|[-+*/%&|^])$/.test(tokens[previous] ?? '');
  const last = compound ? previousSignificantToken(tokens, previous - 1) : previous;
  const qualifier = tokens[previousSignificantToken(tokens, last - 1)];
  if (!isCommandName(tokens[last]) || ['.', '@', '$'].includes(qualifier)) return;
  locals.add(tokens[last]);
  if (compound) return;
  const targets: string[] = [];
  let separator = assignmentSeparator(tokens, last);
  while (tokens[separator] === ',') {
    const target = previousSignificantToken(tokens, separator - 1);
    if (!isCommandName(tokens[target])) return;
    targets.push(tokens[target]);
    separator = assignmentSeparator(tokens, target);
  }
  if (separator < 0 || ['\n', ';', 'do'].includes(tokens[separator])) {
    targets.forEach((target) => locals.add(target));
  }
};

const assignmentSeparator = (tokens: string[], target: number): number => {
  const previous = previousSignificantToken(tokens, target - 1);
  let separator = previous;
  while (tokens[separator] === '\n') separator = previousSignificantToken(tokens, separator - 1);
  return tokens[separator] === ',' ? separator : previous;
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
