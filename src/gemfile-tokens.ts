export const gemfileTokens = (content: string): string[] => {
  const pattern = /#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const putsAssignment = /[^\S\n]*=(?!=|>)/y;
  let previous = '\n';
  let classHeader = false;
  let localPuts = false;
  let putsArgument = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let token = match[0];
    if (token.startsWith('#')) continue;
    const expectsExpression = expressionKeywords.test(previous) || /^(?:\n|;|=|=>|~|!|\(|\[|,|\?|:|&&|\|\|)$/.test(previous);
    if (token === '?' && expectsExpression && content[pattern.lastIndex] === '!') {
      token = '?!';
      pattern.lastIndex++;
    }
    if (((token === '/' || token === '%') && expectsExpression) ||
      (token === '/' && putsArgument && /\S/.test(content[pattern.lastIndex] ?? ''))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        token = content.slice(match.index, end);
        pattern.lastIndex = end;
      }
    }
    if (token.startsWith('<<') && classHeader) {
      // In a singleton class header, << introduces the receiver.
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      previous = '<<';
      classHeader = false;
      continue;
    }
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      if (token === 'puts' || token === 'puts=') {
        putsAssignment.lastIndex = pattern.lastIndex;
        localPuts ||= previous !== '.' && (token === 'puts=' || putsAssignment.test(content));
      }
      putsArgument = !localPuts && token === 'puts' && /^(?:\n|;|do)$/.test(previous) &&
        /[^\S\n]/.test(content[pattern.lastIndex] ?? '');
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      previous = expressionKeywords.test(token) && (previous === '.' || previous === ':')
        ? `${previous}${token}`
        : token;
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

const expressionKeywords = /^(?:if|unless|case|when)$/;
const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^a-zA-Z0-9\u0080-\uffff])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[1] ?? '/';
  const end = literalEnd(content, opening.lastIndex, delimiter, true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  options.exec(content);
  return options.lastIndex;
};

const literalEnd = (content: string, start: number, delimiter: string, interpolates: boolean): number | undefined => {
  const closing = pairedDelimiters.get(delimiter) ?? delimiter;
  let depth = 1;
  let offset = start;
  while (offset < content.length) {
    const char = content[offset++];
    if (char === closing) {
      if (--depth === 0) return offset;
    } else if (char === '\\') {
      offset++;
    } else if (interpolates && char === '#' && content[offset] === '{') {
      const end = interpolationEnd(content, offset + 1);
      if (end === undefined) return undefined;
      offset = end;
    } else if (char === delimiter) {
      depth++;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number): number | undefined => {
  const part = /%([qQ])([^a-zA-Z0-9\u0080-\uffff])|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|#[^\n]*|[\s\S]/y;
  part.lastIndex = start;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = part.exec(content)) !== null) {
    if (match[2]) {
      const end = literalEnd(content, part.lastIndex, match[2], match[1] === 'Q');
      if (end === undefined) return undefined;
      part.lastIndex = end;
    }
    if (match[0] === '{') depth++;
    if (match[0] === '}' && --depth === 0) return part.lastIndex;
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
