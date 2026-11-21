import { gemfileScopeKind, readGemfileStatements } from './gemfile-statements.js';

const regexpCommands = new Set(['puts', 'warn']);
const localAssignment = /^[^\S\n]*(?:(?:\|\||&&|\*\*|<<|>>|[-+*/%&|^])=|=(?![=~>]))/;

export const gemfileTokens = (content: string, onStatement?: (tokens: string[]) => void): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const scopes = [new Set<string>()];
  const statements = readGemfileStatements((statement) => {
    if (statement[0] === 'end' && scopes.length > 1) scopes.pop();
    const kind = gemfileScopeKind(statement);
    const scope = scopes.at(-1)!;
    if (kind === 'shared') scopes.push(scope);
    if (kind === 'block') {
      scopes.push(new Set([...scope, ...readBlockLocals(content, pattern.lastIndex)]));
    }
    if (kind === 'isolated') scopes.push(new Set(readMethodLocals(statement)));
    onStatement?.(statement);
  });
  const emit = (token: string): void => {
    tokens.push(token);
    statements.push(token);
  };
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '=' && !/[=~>]/.test(content[pattern.lastIndex] ?? '')) || /^\w+=$/.test(token)) {
      const targets = [...statements.currentTokens(), token.slice(0, -1)].join(' ').trimEnd();
      if (/^[a-zA-Z_]\w*(?: , [a-zA-Z_]\w*)+$/.test(targets)) {
        targets.split(' , ').filter((name) => regexpCommands.has(name)).forEach((name) => scopes.at(-1)!.add(name));
      }
    }
    const commandName = token.replace(/=$/, '');
    if (regexpCommands.has(commandName)) {
      const qualifier = tokens[previousSignificantToken(tokens, tokens.length - 1)];
      if (!['.', '@', '$', ':'].includes(qualifier ?? '') &&
        (token !== commandName || localAssignment.test(content.slice(pattern.lastIndex)))) {
        scopes.at(-1)!.add(commandName);
      }
    }
    if (token === '?' || token === '/' || token === '%') {
      const previous = previousSignificantToken(tokens, tokens.length - 1);
      const qualifier = tokens[previousSignificantToken(tokens, previous - 1)];
      const command = tokens[previous] ?? '';
      const commandRegexp = token === '/' && regexpCommands.has(command) && !scopes.at(-1)!.has(command) &&
        qualifier !== '@' && qualifier !== '$' &&
        /^[^\S\n]+$/.test(tokens.at(-1) ?? '') && /\S/.test(content[match.index + 1] ?? '');
      if (expectsExpression(tokens[previous] ?? '\n', qualifier) || commandRegexp) {
        const end = token === '?' ? characterEnd(content, match.index) : regexpEnd(content, match.index);
        if (end !== undefined) {
          pattern.lastIndex = end;
          emit('<literal>');
          continue;
        }
      }
    }
    if (token.startsWith('<<')) {
      if (opensSingletonClass(tokens)) {
        emit('<<');
        pattern.lastIndex = match.index + 2;
        continue;
      }
      const indented = /^<<[-~]/.test(token);
      const delimiter = token.slice(indented ? 3 : 2).replace(/^['"`]|['"`]$/g, '');
      pending.push({ delimiter, indented });
      emit('""');
      continue;
    }
    emit(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  statements.finish();
  return tokens;
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const readMethodLocals = (statement: string[]): string[] => {
  if (statement[0] !== 'def') return [];
  const parameters = statement.slice(statement[2] === '.' ? 4 : 2);
  return readParameterLocals(parameters[0] === '(' ? parameters.slice(1, -1) : parameters);
};

const readBlockLocals = (content: string, start: number): string[] => {
  const opening = /(?:\s|#[^\n]*\n)*\|(?!\|)/y;
  opening.lastIndex = start;
  if (!opening.test(content)) return [];

  const pattern = new RegExp(tokenPattern, 'gy');
  pattern.lastIndex = opening.lastIndex;
  return readParameterLocals(matchedTokens(content, pattern), '|');
};

function* matchedTokens(content: string, pattern: RegExp): Iterable<string> {
  for (const [token] of content.matchAll(pattern)) yield token;
}

const readParameterLocals = (tokens: Iterable<string>, terminator?: string): string[] => {
  const locals: string[] = [];
  let depth = 0;
  let binding = true;
  let defaultDepth: number | undefined;
  for (const token of tokens) {
    if (token === terminator && depth === 0) return locals;
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    if ((token === ',' || token === ';') && (defaultDepth === undefined || depth <= defaultDepth)) {
      defaultDepth = undefined;
      binding = true;
    }
    if (token === '=' || token.startsWith(':')) defaultDepth ??= depth;
    const name = token.replace(/=$/, '');
    if (binding && /^\w+$/.test(name)) {
      if (regexpCommands.has(name)) locals.push(name);
      if (name !== token) defaultDepth = depth;
      binding = false;
    }
  }
  return terminator === undefined ? locals : [];
};

const opensSingletonClass = (tokens: string[]): boolean => {
  const index = previousSignificantToken(tokens, tokens.length - 1);
  if (tokens[index] !== 'class') return false;
  const previous = tokens[previousSignificantToken(tokens, index - 1)] ?? '\n';
  return ['\n', ';', '=', 'do'].includes(previous);
};

const previousSignificantToken = (tokens: string[], index: number): number => {
  while (index >= 0 && /^(?:[^\S\n]+|\\\r?\n)$/.test(tokens[index])) index--;
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

const expectsExpression = (previous: string, qualifier: string | undefined): boolean =>
  qualifier !== '.' &&
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|&&|\|\||\?|:|and|or|do|if|elsif|unless|when|return)$/.test(previous);

const characterEnd = (content: string, start: number): number | undefined => {
  const character = /\?(?:\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|(?:[CM]-|c)*[^\r\n])|[^\s\\])/uy;
  character.lastIndex = start;
  return character.test(content) ? character.lastIndex : undefined;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation: boolean) => {
  const opening = inInterpolation
    ? /\/|%(r|[qQwWiIxs]?)([^\p{L}\p{N}\s])/uy
    : /\/|%(r)([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  const kind = match[1] ?? 'r';
  return {
    start: opening.lastIndex,
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    interpolates: !['q', 'w', 'i', 's'].includes(kind),
    regexp: kind === 'r',
    depth: 1,
    braces: 0,
    previous: '{',
    qualifier: undefined as string | undefined,
  };
};

const regexpEnd = (content: string, start: number): number | undefined => {
  const initial = literalFrame(content, start, false);
  if (!initial) return undefined;
  const frames = [initial];
  const expression = new RegExp(tokenPattern, 'y');
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    const char = content[offset];
    if (frame.braces > 0) {
      expression.lastIndex = offset;
      const token = expression.exec(content)?.[0] ?? char;
      const expectsValue = expectsExpression(frame.previous, frame.qualifier);
      const character = token === '?' && expectsValue ? characterEnd(content, offset) : undefined;
      if (character !== undefined) {
        frame.previous = '<literal>';
        offset = character;
        continue;
      }
      const nested = (token === '/' || token === '%') && expectsValue
        ? literalFrame(content, offset, true)
        : undefined;
      if (nested) {
        frames.push(nested);
        frame.previous = '<literal>';
        offset = nested.start;
        continue;
      }
      if (token === '{') frame.braces++;
      if (token === '}') frame.braces--;
      if (!/^(?:[^\S\n]+|\\\r?\n|#)/.test(token)) {
        frame.qualifier = frame.previous;
        frame.previous = token;
      }
      offset += token.length;
    } else if (char === frame.closing) {
      offset++;
      if (--frame.depth !== 0) continue;
      if (frame.regexp) {
        options.lastIndex = offset;
        options.exec(content);
        offset = options.lastIndex;
      }
      frames.pop();
      if (frames.length === 0) return offset;
    } else if (char === '\\') {
      offset += 2;
    } else if (frame.interpolates && char === '#' && content[offset + 1] === '{') {
      frame.braces = 1;
      frame.previous = '{';
      frame.qualifier = undefined;
      offset += 2;
    } else {
      if (char === frame.delimiter) frame.depth++;
      offset++;
    }
  }
  return undefined;
};
