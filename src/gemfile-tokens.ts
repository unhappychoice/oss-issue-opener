import { opensLocalScope, opensScope, splitGemfileStatements } from './gemfile-scopes.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const assignments = new Map(commandNames.map((name) => [name, new Set<number>()]));
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const compoundAssignment = compoundAssignmentPattern.test(token);
    if (token === '=' || compoundAssignment || token === '/' || token === '%' || token === '?') {
      const index = previousSignificantToken(tokens, tokens.length - 1);
      const previous = tokens[index];
      const qualifier = tokens[previousSignificantToken(tokens, index - 1)];
      const qualified = ['.', ':', '@', '$'].includes(qualifier);
      if (token === '=' || compoundAssignment) {
        if (compoundAssignment || !/^[=~]/.test(content[pattern.lastIndex] ?? '')) {
          assignments.forEach((scopes, name) => {
            const assignsLocal = (previous === name && !qualified) ||
              (!compoundAssignment && assignsParallelLocal(tokens, name));
            if (assignsLocal && !declaresMethodParameter(splitGemfileStatements(tokens).at(-1) ?? [], name)) {
              scopes.add(currentLocalScope(tokens, name).index);
            }
          });
        }
      } else if (expectsRegexp(previous, qualifier) ||
        (startsCommandRegexp(previous, qualifier, content, match.index) &&
          (qualified || !hasLocalBinding(tokens, previous, assignments.get(previous)!)))) {
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
  (previous !== '.' && /^(?:!|and|or|do|if|elsif|unless|case|when|return)$/.test(token));

const commandNames = ['puts', 'warn'] as const;
type CommandName = typeof commandNames[number];

const startsCommandRegexp = (
  previous: string | undefined, qualifier: string | undefined, content: string, start: number,
): previous is CommandName => {
  if ((previous !== 'puts' && previous !== 'warn') || qualifier === '@' || qualifier === '$') return false;
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

const hasLocalBinding = (tokens: string[], name: CommandName, assignments: Set<number>): boolean => {
  let scope: LocalScope | undefined = currentLocalScope(tokens, name);
  while (scope) {
    if (scope.bindsName || assignments.has(scope.index)) return true;
    scope = scope.parent;
  }
  return false;
};

type LocalScope = { index: number; bindsName: boolean; parent?: LocalScope };

const currentLocalScope = (tokens: string[], name: CommandName): LocalScope => {
  const topLevel: LocalScope = { index: -1, bindsName: false };
  const scopes: LocalScope[] = [];
  splitGemfileStatements(tokens).forEach((statement, index) => {
    if (statement[0] === 'end') scopes.pop();
    const scope = scopes.at(-1) ?? topLevel;
    if (bindsForTarget(statement, name)) scope.bindsName = true;
    if (statement[0] === '|' && hasParameter(statement.slice(1, -1), name)) scope.bindsName = true;
    if (opensScope(statement)) {
      scopes.push(opensLocalScope(statement)
        ? { index, bindsName: declaresMethodParameter(statement, name) }
        : opensBlockScope(statement) ? { index, bindsName: false, parent: scope } : scope);
    }
  });
  return scopes.at(-1) ?? topLevel;
};

const opensBlockScope = (statement: string[]): boolean =>
  statement.at(-1) === 'do' && !/^(?:for|until|while)$/.test(statement[0]);

const bindsForTarget = (statement: string[], name: CommandName): boolean => {
  if (statement[0] !== 'for') return false;
  const inIndex = statement.indexOf('in');
  if (inIndex < 0) return false;
  const targets = statement.slice(1, inIndex);
  return targets.some((token, index) => token === name &&
    (index === 0 || [',', '(', '*'].includes(targets[index - 1])) &&
    (index === targets.length - 1 || [',', ')'].includes(targets[index + 1])));
};

const declaresMethodParameter = (statement: string[], name: CommandName): boolean => {
  if (statement[0] !== 'def') return false;
  const parameters = statement.slice(statement[2] === '.' ? 4 : 2);
  if (parameters[0] === '(') parameters.shift();
  return hasParameter(parameters, name);
};

const hasParameter = (parameters: string[], name: CommandName): boolean => {
  let depth = 0;
  let atParameterStart = true;
  for (const token of parameters) {
    if (atParameterStart && token === name) return true;
    if (atParameterStart && ['*', '&'].includes(token)) continue;
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    atParameterStart = depth === 0 && (token === ',' || token === ';');
  }
  return false;
};

const assignmentTarget = String.raw`(?:(?:\* )?\w+|\*)`;
const assignmentList = `${assignmentTarget}(?: , ${assignmentTarget})*(?: ,)?`;
const groupedAssignment = new RegExp(String.raw`\( (${assignmentList}) \)`, 'g');
const parallelAssignment = new RegExp(`^${assignmentList}$`);

const assignsParallelLocal = (tokens: string[], name: CommandName): boolean => {
  let targets = splitGemfileStatements(tokens).at(-1)?.join(' ') ?? '';
  let previous: string;
  do {
    previous = targets;
    targets = targets.replace(groupedAssignment, (_, group: string) => group.split(' ').includes(name) ? name : '_');
  } while (targets !== previous);
  return parallelAssignment.test(targets) && targets.split(' ').includes(name);
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
