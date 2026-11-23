export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const locals = new LocalScopes();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '%' || (token === '/' &&
      (expectsRegexp(tokens) || followsCommand(tokens, content[pattern.lastIndex], locals.names)))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        tokens.push(content.slice(match.index, end));
        pattern.lastIndex = end;
        continue;
      }
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
    locals.read(token, tokens, content, pattern.lastIndex);
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

type LocalScope = { closing: 'end' | '}' | 'line'; names: Set<string>; loopHeader?: boolean };

class LocalScopes {
  get names(): Set<string> {
    return this.scopes.at(-1)?.names ?? this.root;
  }

  read(token: string, tokens: string[], content: string, offset: number): void {
    if (isTokenSpacing(token)) return;
    const previous = tokens[previousTokenIndex(tokens)];
    const startsStatement = previous === undefined || /^(?:\n|;|do|then|else|\{)$/.test(previous);
    const lineEnd = (token === '\n' || token === ';') && this.depth === 0;
    if (token === '(' || token === '[') this.depth++;
    if (token === ')' || token === ']') this.depth--;
    if (this.depth === 0) this.updateScope(token, previous, startsStatement, lineEnd, tokens);
    if (lineEnd) this.methodStart = undefined;
    this.assignment.lastIndex = offset;
    if (isLocalName(token) && previous !== '.' && previous !== 'def' &&
      (this.methodStart !== undefined || this.assignment.test(content))) {
      this.names.add(token);
    }
  }

  private readonly root = new Set<string>();
  private readonly scopes: LocalScope[] = [];
  private readonly assignment = /[ \t]*=(?!=|[>~])/y;
  private methodStart: number | undefined;
  private depth = 0;

  private updateScope(
    token: string, previous: string | undefined, startsStatement: boolean, lineEnd: boolean, tokens: string[],
  ): void {
    const scope = this.scopes.at(-1);
    if ((token === 'end' && scope?.closing === 'end' && previous !== '.') ||
      (token === '}' && scope?.closing === '}') || (lineEnd && scope?.closing === 'line')) {
      this.scopes.pop();
      this.methodStart = undefined;
    } else if (startsStatement && token === 'def') {
      this.scopes.push({ closing: 'end', names: new Set() });
      this.methodStart = tokens.length;
    } else if ((startsStatement || previous === '=') && /^(?:class|module)$/.test(token)) {
      this.scopes.push({ closing: 'end', names: new Set() });
    } else if (token === '=' && this.methodStart !== undefined &&
      isEndlessMethod([...tokens.slice(this.methodStart).filter((part) => !isTokenSpacing(part)), token])) {
      if (scope) scope.closing = 'line';
      this.methodStart = undefined;
    } else {
      this.updateBlock(token, previous, startsStatement, lineEnd, scope);
    }
  }

  private updateBlock(
    token: string, previous: string | undefined, startsStatement: boolean, lineEnd: boolean,
    scope: LocalScope | undefined,
  ): void {
    if (token === 'do' && scope?.loopHeader) {
      scope.loopHeader = false;
    } else if ((token === 'do' && previous !== '.') ||
      (startsStatement && /^(?:if|unless|case|begin|while|until|for)$/.test(token))) {
      this.scopes.push({ closing: 'end', names: this.names, loopHeader: /^(?:while|until|for)$/.test(token) });
    } else if (token === '{') {
      this.scopes.push({ closing: '}', names: this.names });
    } else if (lineEnd && scope?.loopHeader) {
      scope.loopHeader = false;
    }
  }
}

const isLocalName = (token: string): boolean => /^[a-z_]\w*$/.test(token);

const followsCommand = (tokens: string[], next: string | undefined, localNames: Set<string>): boolean => {
  if (!next || /[\s=]/.test(next) || !/^[^\S\n]+$/.test(tokens.at(-1) ?? '')) return false;
  const index = previousTokenIndex(tokens);
  const name = tokens[index] ?? '';
  if (!/^[a-z_]\w*[!?]?$/.test(name)) return false;
  const before = tokens[previousTokenIndex(tokens, index - 1)];
  if (before === '.') return true;
  return !localNames.has(name) && !/^(?:true|false|nil|self|end|super)$/.test(name) &&
    (before === undefined || /^(?:\n|;|=|do|then|else|return|yield)$/.test(before));
};

const expectsRegexp = (tokens: string[]): boolean => {
  const index = previousTokenIndex(tokens);
  const previous = tokens[index] ?? '\n';
  return /^(?:\n|;|=|=>|~|\(|\[|,|&&|\|\||\?|:|!)$/.test(previous) ||
    (/^(?:do|if|elsif|unless)$/.test(previous) && tokens[previousTokenIndex(tokens, index - 1)] !== '.');
};

const literalDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const literalEnd = (
  content: string, start: number, delimiter: string, interpolates: boolean,
): number | undefined => {
  const closing = literalDelimiters.get(delimiter) ?? delimiter;
  const part = /\\[\s\S]|[\s\S]/gu;
  part.lastIndex = start;
  let depth = 1;
  for (let token = part.exec(content); token; token = part.exec(content)) {
    if (interpolates && token[0] === '#' && content[part.lastIndex] === '{') {
      const end = interpolationEnd(content, part.lastIndex + 1);
      if (end === undefined) return undefined;
      part.lastIndex = end;
      continue;
    }
    if (token[0] === closing && --depth === 0) return part.lastIndex;
    if (token[0] === delimiter && delimiter !== closing) depth++;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const part = /#[^\n]*|%([qQwWiIrxs])([^\p{L}\p{N}\s])|\\[\s\S]|\w+[!?]?|&&|\|\||=>|[\s\S]/gu;
  part.lastIndex = start;
  const tokens: string[] = [];
  let depth = 1;
  for (let match = part.exec(content); match; match = part.exec(content)) {
    const [token, percentType, delimiter] = match;
    if (token.startsWith('#')) continue;
    if (token === '}' && --depth === 0) return part.lastIndex;
    if (token === '{') depth++;
    const end = delimiter
      ? literalEnd(content, part.lastIndex, delimiter, 'QWIrx'.includes(percentType))
      : interpolationLiteralEnd(content, token, match.index, tokens);
    if (end !== undefined) part.lastIndex = end;
    tokens.push(end === undefined ? token : '""');
  }
  return undefined;
};

const interpolationLiteralEnd = (
  content: string, token: string, start: number, tokens: string[],
): number | undefined => {
  if (token === '/' && expectsRegexp(tokens)) return regexpEnd(content, start);
  if (token === '%' && expectsRegexp(tokens)) {
    const opening = /%([^\p{L}\p{N}\s])/uy;
    opening.lastIndex = start;
    const match = opening.exec(content);
    if (match) return literalEnd(content, opening.lastIndex, match[1], true);
  }
  if (token === "'" || token === '"' || token === '`') {
    return literalEnd(content, start + 1, token, token !== "'");
  }
  return undefined;
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
