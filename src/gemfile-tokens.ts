import { GemfileStatements, gemfileScope } from './gemfile-statements.js';

export const gemfileTokens = (content: string): string[] => scanGemfile(content).tokens;

export const gemfileStatements = (content: string): string[][] => scanGemfile(content).statements;

const scanGemfile = (content: string) => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let literalExpected = true;
  let commandArgument = false;
  const statements: string[][] = [];
  const scopes = [new Set<string>()];
  let assignedCommand: string | undefined;
  const parser = new GemfileStatements((statement) => {
    statements.push(statement);
    const parent = scopes.at(-1)!;
    const scope = gemfileScope(statement);
    if (assignedCommand && statement[0] !== 'def') parent.add(assignedCommand);
    assignedCommand = undefined;
    if (statement[0] === 'end' && scopes.length > 1) scopes.pop();
    if (scope === 'isolated') scopes.push(new Set());
    if (scope === 'control') scopes.push(parent);
    if (scope === 'block') {
      scopes.push(new Set([...parent, ...commandBlockParameters(content, pattern.lastIndex)]));
    }
  });
  const append = (token: string): void => {
    tokens.push(token);
    parser.push(token);
  };
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((literalExpected && (token === '/' || token === '%')) ||
      (commandArgument && token === '/' && /\S/.test(content.charAt(pattern.lastIndex)))) {
      const end = literalEnd(content, match.index);
      if (end !== undefined && (literalExpected || isCommandRegexpEnd(content, match.index, end))) {
        token = content.slice(match.index, end);
        pattern.lastIndex = end;
      }
    }
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      append('<<');
      classHeader = false;
      previous = '<<';
      literalExpected = false;
      commandArgument = false;
      continue;
    }
    if (!isSpacing(token)) {
      const command = token.replace(/=$/, '');
      if (regexpCommands.includes(command)) {
        const bare = !['.', ':', '@', '$'].includes(previous);
        if (bare && (token.endsWith('=') || isAssignment(content, pattern.lastIndex))) {
          assignedCommand = command;
        }
      }
      commandArgument = regexpCommands.includes(token) && !scopes.at(-1)!.has(token) &&
        /^(?:\n|;|do)$/.test(previous) &&
        /[^\S\n]/.test(content.charAt(pattern.lastIndex));
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      literalExpected = expectsLiteral(token, previous);
      previous = token;
    }
    if (token.startsWith('<<')) {
      const indented = /^<<[-~]/.test(token);
      const delimiter = token.slice(indented ? 3 : 2).replace(/^['"`]|['"`]$/g, '');
      pending.push({ delimiter, indented });
      append('""');
      continue;
    }
    append(token);
    if (token === '\n') {
      pending.splice(0).forEach(({ delimiter, indented }) => {
        pattern.lastIndex = heredocEnd(content, pattern.lastIndex, delimiter, indented);
      });
    }
  }
  parser.finish();
  return { tokens, statements };
};

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const isCommandRegexpEnd = (content: string, start: number, end: number): boolean =>
  !/[\w'"`]/.test(content.charAt(end)) &&
  !/\n[\t ]*end\b[^\n]*\n[\s\S]*?^[\t ]*#[^\n]*\/[imxounes]*$/m.test(content.slice(start, end));

const regexpCommands = ['puts', 'warn'];

const commandBlockParameters = (content: string, start: number): string[] => {
  const parameters = /\s*\|([^|]*)\|/y;
  parameters.lastIndex = start;
  const names = parameters.exec(content)?.[1] ?? '';
  return regexpCommands.filter((command) =>
    new RegExp(`(?:^|[,;(*&])\\s*${command}\\s*(?:$|[,;)=:])`).test(names));
};

const isAssignment = (content: string, start: number): boolean => {
  const assignment = /[^\S\n]*(?:\|\||&&|[+*/%&|^-])?=(?!=|>|~)/y;
  assignment.lastIndex = start;
  return assignment.test(content);
};

const expectsLiteral = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|&&|\|\||!|~|\(|\[|\{|,|\?|:)$/.test(token) ||
  (/^(?:if|unless|when|and|or)$/.test(token) && !['.', ':', '@', '$'].includes(previous));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%[rqQ]([^\w\s])/y;
  opening.lastIndex = start;
  const root = opening.exec(content);
  if (!root) return undefined;

  const expression = new RegExp(tokenPattern, 'y');
  const interpolated = /\\[\s\S]|#\{|[\s\S]/y;
  const plain = /\\[\s\S]|[\s\S]/y;
  const options = /[imxounes]*/y;
  const frames = [literalFrame(root[1] ? root[0].slice(0, 2) : '/', root[1] ?? '/')];
  let offset = opening.lastIndex;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    const part = frame.braces > 0 ? expression : frame.kind === '%q' ? plain : interpolated;
    part.lastIndex = offset;
    const token = part.exec(content)?.[0];
    if (!token) return undefined;
    offset = part.lastIndex;

    if (frame.braces === 0) {
      if (token === frame.closing && --frame.depth === 0) {
        frames.pop();
        if (frame.kind === '/' || frame.kind === '%r') {
          options.lastIndex = offset;
          options.exec(content);
          offset = options.lastIndex;
        }
        if (frames.length === 0) return offset;
      } else if (frame.delimiter !== frame.closing && token === frame.delimiter) {
        frame.depth++;
      } else if (token === '#{') {
        frame.braces = 1;
        frame.previous = '{';
        frame.literalExpected = true;
      }
      continue;
    }

    if (isSpacing(token) || token.startsWith('#')) continue;
    if ((token === '/' || token === '%') && frame.literalExpected) {
      opening.lastIndex = offset - 1;
      const match = opening.exec(content);
      if (match) {
        frames.push(literalFrame(match[0].slice(0, match[1] ? 2 : 1), match[1] ?? '/'));
        offset = opening.lastIndex;
      }
    }
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.literalExpected = expectsLiteral(token, frame.previous);
    frame.previous = token;
  }
  return undefined;
};

const literalFrame = (kind: string, delimiter: string) => ({
  kind,
  delimiter,
  closing: pairedDelimiters.get(delimiter) ?? delimiter,
  depth: 1,
  braces: 0,
  previous: '',
  literalExpected: false,
});

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
