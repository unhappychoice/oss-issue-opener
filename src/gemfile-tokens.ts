export const gemfileTokens = (content: string): string[] => {
  const pattern = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|::|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let expressionExpected = true;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#')) continue;
    if (expressionExpected && (token === '?' || token === '/' || token === '%')) {
      const end = token === '?' ? characterEnd(content, match.index) : delimitedLiteralEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        tokens.push(content.slice(match.index, end));
        previous = token;
        expressionExpected = false;
        classHeader = false;
        continue;
      }
    }
    if (token.startsWith('<<') && classHeader) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      expressionExpected = false;
      classHeader = false;
      continue;
    }
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      expressionExpected = /^(?:\n|;|=|=>|&&|\|\||!|~|\(|\[|,|\?|:)$/.test(token)
        || (/^(?:if|elsif|unless)$/.test(token) && previous !== '.' && previous !== '::');
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
