import { gemfileStatements, opensBlock, opensNamespace } from './gemfile-scopes.js';

export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const previousIndex = previousTokenIndex(tokens);
    const literalEnd = expressionLiteralEnd(
      content, match.index, token, tokens[previousIndex], tokens[previousTokenIndex(tokens, previousIndex)],
      (name) => hasLocalBinding(tokens, name),
    );
    if (literalEnd !== undefined) {
      tokens.push(content.slice(match.index, literalEnd));
      pattern.lastIndex = literalEnd;
      continue;
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
    tokens.push(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  return tokens;
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|::|:\w+|(?:@@?|\$)[A-Za-z_]\w*|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const expectsRegexp = (previous?: string, beforePrevious?: string): boolean =>
  previous === undefined || /^(?:\n|;|=|=>|~|[([{,:?+!]|&&|\|\|)$/.test(previous) ||
  (beforePrevious !== '.' && beforePrevious !== '::' && /^(?:do|if|elsif|unless|return)$/.test(previous));

const hasLocalBinding = (tokens: string[], name: string): boolean => {
  let local = { bound: false };
  const scopes: typeof local[] = [];
  gemfileStatements(tokens).forEach((statement, index, statements) => {
    if (statement[0] === 'end') {
      local = scopes.pop() ?? local;
      return;
    }
    if (opensBlock(statement)) scopes.push(local);
    if (statement[0] === 'def') {
      local = { bound: hasParameter(statement, name) };
    } else if (opensNamespace(statement)) {
      local = { bound: false };
    } else if (statement.at(-1) === 'do' && hasBlockParameter(statements[index + 1] ?? [], name)) {
      local = { bound: true };
    } else if (assignsLocal(statement, name) || bindsArrayPatternLocal(statement, name)) {
      local.bound = true;
    }
  });
  return local.bound;
};

const bindsArrayPatternLocal = (statement: string[], name: string): boolean => {
  if (statement[0] !== 'in' || statement[1] !== '[') return false;
  let depth = 1;
  for (let index = 2; index < statement.length && depth > 0; index++) {
    const token = statement[index];
    if (depth === 1 && token === name && ['[', ',', '*'].includes(statement[index - 1]) &&
      [',', ']'].includes(statement[index + 1])) return true;
    if (['[', '(', '{'].includes(token)) depth++;
    if ([']', ')', '}'].includes(token)) depth--;
  }
  return false;
};

const assignsLocal = (statement: string[], name: string): boolean => {
  if (statement[0] === 'for') {
    const targets = statement.slice(1, statement.indexOf('in'));
    if (targets.some((token, index) => token === name &&
      (index === 0 || [',', '*'].includes(targets[index - 1])) &&
      (index === targets.length - 1 || targets[index + 1] === ','))) return true;
  }
  if (statement.some((token, index) => {
    if (token !== name || isQualifiedName(statement[index - 1])) return false;
    const operator = statement[index + 1];
    const next = statement[index + 2];
    return operator === '=' ? !['=', '~'].includes(next) : ['||', '&&'].includes(operator) && next === '=';
  })) return true;

  const equals = statement.indexOf('=');
  const targets = statement.slice(0, equals);
  return equals >= 2 && targets.includes(name) &&
    targets.every((token, index) => index % 2 === 1 ? token === ',' : /^(?:@@?|\$)?[A-Za-z_]\w*$/.test(token));
};

const hasParameter = (statement: string[], name: string): boolean => {
  const parameters = statement.slice(isQualifiedName(statement[2]) ? 4 : 2);
  return bindsParameter(parameters[0] === '(' ? parameters.slice(1) : parameters, name);
};

const hasBlockParameter = (statement: string[], name: string): boolean => {
  const end = statement.indexOf('|', 1);
  return statement[0] === '|' && end !== -1 && bindsParameter(statement.slice(1, end), name);
};

const bindsParameter = (parameters: string[], name: string): boolean => {
  const bindingContexts = [true];
  return parameters.some((token, index) => {
    const atBinding = bindingContexts.at(-1) && startsParameter(parameters, index);
    if (['(', '[', '{'].includes(token)) bindingContexts.push(token === '(' && Boolean(atBinding));
    if ([')', ']', '}'].includes(token)) bindingContexts.pop();
    return atBinding === true && token === name;
  });
};

const startsParameter = (parameters: string[], index: number): boolean => {
  let previous = index - 1;
  while (['*', '&'].includes(parameters[previous])) previous--;
  return previous < 0 || [',', '('].includes(parameters[previous]);
};

const isQualifiedName = (previous?: string): boolean =>
  previous === '.' || previous === ':' || previous === '::';

const expressionLiteralEnd = (
  content: string, start: number, token: string, previous?: string, beforePrevious?: string, hasLocal?: (name: string) => boolean,
): number | undefined => {
  if (token === '?' && content[start + 1] === '/' && expectsRegexp(previous, beforePrevious)) return start + 2;
  if (token !== '/' && token !== '%') return undefined;
  const commandArgument = (previous === 'warn' || previous === 'puts') && token === '/' &&
    /[^\S\n]/.test(content[start - 1] ?? '') && /^[^\s=]$/.test(content[start + 1] ?? '') &&
    (isQualifiedName(beforePrevious) || !hasLocal?.(previous));
  if (!commandArgument && !expectsRegexp(previous, beforePrevious)) return undefined;
  const opening = /\/|%r([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return percentLiteralEnd(content, start);
  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalEnd = (
  content: string, start: number, opening: string, interpolates: boolean,
): number | undefined => {
  const closing = pairedDelimiters.get(opening) ?? opening;
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    const char = content[index];
    if (char === '\\') {
      index++;
    } else if (char === closing) {
      if (--depth === 0) return index + 1;
    } else if (interpolates && char === '#' && content[index + 1] === '{') {
      const end = interpolationEnd(content, index + 2);
      if (end === undefined) return undefined;
      index = end - 1;
    } else if (char === opening) {
      depth++;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const pattern = new RegExp(tokenPattern, 'gy');
  pattern.lastIndex = start;
  let depth = 1;
  let previous = '{';
  let beforePrevious: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin') || isTokenSpacing(token)) continue;
    const end = expressionLiteralEnd(content, match.index, token, previous, beforePrevious);
    beforePrevious = previous;
    if (end !== undefined) {
      pattern.lastIndex = end;
      previous = 'literal';
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return pattern.lastIndex;
    previous = token;
  }
  return undefined;
};

const percentLiteralEnd = (content: string, start: number): number | undefined => {
  const opening = /%([qQwWiI]?)([^\w\s\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  return match ? literalEnd(content, opening.lastIndex, match[2], !['q', 'w', 'i'].includes(match[1])) : undefined;
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
