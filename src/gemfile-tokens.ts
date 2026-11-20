import { blockKind, createGemfileStatementCollector } from './gemfile-scopes.js';

export const gemfileTokens = (content: string, onStatement?: (tokens: string[]) => void): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|::|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let expressionExpected = true;
  let classHeader = false;
  let putsArgument = false;
  let locals = { puts: false };
  const enclosingLocals: { puts: boolean }[] = [];
  const statements = createGemfileStatementCollector((statement) => {
    onStatement?.(statement);
    if (statement[0] === 'end') locals = enclosingLocals.pop() ?? locals;
    const kind = blockKind(statement);
    if (!kind) return;
    enclosingLocals.push(locals);
    if (kind === 'namespace') locals = { puts: false };
    if (kind === 'method') locals = { puts: hasPutsParameter(statement) };
  });
  const emit = (token: string) => {
    tokens.push(token);
    statements.push(token);
  };
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    const commandRegexp = token === '/' && putsArgument &&
      /[ \t]/.test(content[match.index - 1] ?? '') && /[^\s=]/.test(content[pattern.lastIndex] ?? '');
    if (commandRegexp || (expressionExpected && (token === '?' || token === '/' || token === '%'))) {
      const end = token === '?' ? characterEnd(content, match.index) : delimitedLiteralEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        emit(content.slice(match.index, end));
        previous = token;
        expressionExpected = false;
        classHeader = false;
        putsArgument = false;
        continue;
      }
    }
    if (token.startsWith('<<') && classHeader) {
      pattern.lastIndex = match.index + 2;
      emit('<<');
      previous = '<<';
      expressionExpected = false;
      classHeader = false;
      continue;
    }
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      if (token === '=' && previous === 'puts' && putsArgument) locals.puts = true;
      putsArgument = token === 'puts' && !locals.puts && (expressionExpected || previous === 'do');
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      expressionExpected = /^(?:\n|;|=|=>|&&|\|\||!|~|\(|\[|,|\?|:)$/.test(token)
        || (/^(?:if|elsif|unless)$/.test(token) && previous !== '.' && previous !== '::');
      previous = token;
    }
    if (token.startsWith('<<')) {
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

const hasPutsParameter = (statement: string[]): boolean => {
  const parameterStart = statement[2] === '.' || statement[2] === '::' ? 4 : 2;
  return statement.slice(parameterStart).some((token, index, parameters) =>
    token === 'puts' && (index === 0 || ['(', ',', '*', '&'].includes(parameters[index - 1] ?? '')));
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const characterEnd = (content: string, start: number): number | undefined => {
  const character = /\?(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{1,2}|[0-7]{1,3}|(?:[CM]-\\|c\\)*(?:[CM]-|c)?[^\r\n])|[^\s\\])/uy;
  character.lastIndex = start;
  return character.test(content) ? character.lastIndex : undefined;
};

const delimitedLiteralEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%([qQwWiIxrs]?)([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;

  const [, type, delimiter] = match;
  const end = literalEnd(content, opening.lastIndex, delimiter ?? '/', percentInterpolates(type));
  if (end === undefined || (delimiter !== undefined && type !== 'r')) return end;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const percentInterpolates = (type: string | undefined): boolean => !/^[qwis]$/.test(type ?? '');

const literalEnd = (content: string, start: number, delimiter: string, interpolates: boolean): number | undefined => {
  const closing = pairedDelimiters.get(delimiter) ?? delimiter;
  const parts = /\\[\s\S]|[\s\S]/y;
  parts.lastIndex = start;
  let depth = 1;
  let part: RegExpExecArray | null;
  while ((part = parts.exec(content)) !== null) {
    if (interpolates && part[0] === '#' && content[parts.lastIndex] === '{') {
      const end = interpolationEnd(content, parts.lastIndex + 1);
      if (end === undefined) return undefined;
      parts.lastIndex = end;
      continue;
    }
    if (delimiter !== closing && part[0] === delimiter) depth++;
    if (part[0] === closing && --depth === 0) return parts.lastIndex;
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const parts = /(['"\x60])|%([qQwWiIxrs]?)([^\w\s])|#[^\n]*|[\s\S]/y;
  parts.lastIndex = start;
  let depth = 1;
  let part: RegExpExecArray | null;
  while ((part = parts.exec(content)) !== null) {
    const delimiter = part[1] ?? part[3];
    if (delimiter !== undefined) {
      const interpolates = part[1] !== "'" && percentInterpolates(part[2]);
      const end = literalEnd(content, parts.lastIndex, delimiter, interpolates);
      if (end === undefined) return undefined;
      parts.lastIndex = end;
    }
    if (part[0] === '{') depth++;
    if (part[0] === '}' && --depth === 0) return parts.lastIndex;
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
