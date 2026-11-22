export const opensGemfileLiteral = (token: string, previous = '\n', beforePrevious?: string): boolean => {
  if (token === '`') return !['.', ':', 'def'].includes(previous);
  return (token === '/' || token === '%' || token === '?') && beforePrevious !== '.' &&
    /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|\?|:|&&|\|\||do|if|elsif|unless|case|when|then|return)$/.test(previous);
};

export const rubyLiteralEnd = (content: string, start: number, expression: RegExp): number | undefined => {
  if (content[start] === '?') return content[start + 1] === '/' ? start + 2 : undefined;
  if (content[start] === '`') return literalEnd(content, start + 1, '`', true, new RegExp(expression, 'y'));
  if (content[start] === '/') return regexpEnd(content, start, expression);
  const match = percentLiteralOpening(content, start);
  if (!match) return undefined;
  if (match[1] === 'r') return regexpEnd(content, start, expression);
  return literalEnd(content, start + match[0].length, match[2], !/^[qwis]$/.test(match[1]), expression);
};

const percentLiteralOpening = (content: string, start: number): RegExpExecArray | null => {
  const opening = /%([qQwWiIrxs]?)([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  return opening.exec(content);
};

const regexpEnd = (content: string, start: number, tokenPattern: RegExp): number | undefined => {
  const opening = /\/|%r([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true, new RegExp(tokenPattern, 'y'));
  if (end === undefined) return undefined;
  const options = /[imxounes]*/y;
  options.lastIndex = end;
  return end + options.exec(content)![0].length;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalEnd = (
  content: string, start: number, delimiter: string, interpolates: boolean, expression: RegExp,
): number | undefined => {
  const closing = pairedDelimiters.get(delimiter) ?? delimiter;
  let depth = 1;
  let offset = start;
  while (offset < content.length) {
    const char = content[offset++];
    if (char === closing && --depth === 0) return offset;
    if (char === '\\') {
      offset++;
    } else if (interpolates && char === '#' && content[offset] === '{') {
      const end = interpolationEnd(content, offset + 1, expression);
      if (end === undefined) return undefined;
      offset = end;
    } else if (char === delimiter && delimiter !== closing) {
      depth++;
    }
  }
  return undefined;
};

const interpolationEnd = (content: string, start: number, expression: RegExp): number | undefined => {
  let previous = '{';
  let beforePrevious: string | undefined;
  let depth = 1;
  let offset = start;
  while (offset < content.length) {
    expression.lastIndex = offset;
    const token = expression.exec(content)?.[0];
    if (!token) return undefined;
    const tokenStart = offset;
    offset = expression.lastIndex;
    if (token.startsWith('#') || token.startsWith('=begin') || /^(?:[^\S\n]+|\\\r?\n)$/.test(token)) continue;
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) return offset;
    if (opensGemfileLiteral(token, previous, beforePrevious)) {
      const end = rubyLiteralEnd(content, tokenStart, expression);
      if (end !== undefined) {
        offset = end;
        beforePrevious = previous;
        previous = '';
        continue;
      }
    }
    beforePrevious = previous;
    previous = token;
  }
  return undefined;
};
