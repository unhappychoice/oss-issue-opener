export const gemfileTokens = (content: string): string[] => {
  const pattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|[^\S\n]+|\n|./g;
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  const assignedLocals = new Set<string>();
  const assignment = /([a-z_]\w*)[ \t]*=(?!=|>|~)/y;
  let previous = '\n';
  let regexpExpected = true;
  let command = false;
  let classHeader = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    let token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if (token === '?' && regexpExpected && content[pattern.lastIndex] === '/') {
      pattern.lastIndex++;
      token = '?/';
    }
    if (((token === '/' || token === '%') && regexpExpected) ||
        (token === '/' && command && !assignedLocals.has(previous) && isCommandArgument(content, match.index))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        token = '//';
      }
    }
    if (classHeader && token.startsWith('<<')) {
      // In a singleton class header, << introduces the receiver.
      pattern.lastIndex = match.index + 2;
      token = '<<';
    }
    if (!/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) {
      const startsStatement = /^(?:\n|;|do)$/.test(previous);
      command = startsStatement && /^[a-z_]\w*[!?]?$/.test(token);
      if (startsStatement) {
        assignment.lastIndex = match.index;
        const local = assignment.exec(content);
        if (local) assignedLocals.add(local[1]);
      }
      classHeader = token === 'class' && /^(?:\n|;|=|do)$/.test(previous);
      regexpExpected = expectsRegexp(token, previous);
      previous = token;
    }
    if (token.length > 2 && token.startsWith('<<')) {
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

const expectsRegexp = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|!|\(|\[|\{|,|\?|:)$/.test(token) ||
  (previous !== '.' && /^(?:if|elsif|unless|when|return)$/.test(token));

const isCommandArgument = (content: string, start: number): boolean =>
  /[ \t]/.test(content[start - 1] ?? '') && /[^\s=]/.test(content[start + 1] ?? '');

const regexpEnd = (content: string, start: number): number | undefined => {
  const opening = /\/|%r([^\w\s])/y;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const end = literalEnd(content, opening.lastIndex, match[1] ?? '/', true);
  if (end === undefined) return undefined;
  const options = /[imxounes]*(?!\w)/y;
  options.lastIndex = end;
  return options.test(content) ? options.lastIndex : undefined;
};

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (opening: string, interpolates: boolean) => ({
  kind: 'literal' as const,
  opening,
  closing: pairedDelimiters.get(opening) ?? opening,
  interpolates,
  depth: 1,
});

const interpolationFrame = () => ({ kind: 'expression' as const, depth: 1, previous: '{', regexpExpected: true });

const literalEnd = (content: string, start: number, opening: string, interpolates: boolean): number | undefined => {
  const frames: (ReturnType<typeof literalFrame> | ReturnType<typeof interpolationFrame>)[] = [
    literalFrame(opening, interpolates),
  ];
  const expression = /\n|[^\S\n]+|#[^\n]*|:\w+|\w+[!?]?|=>|[\s\S]/y;
  const percent = /%([qQwWiIrxs]?)([^\w\s])/y;
  let offset = start;
  while (frames.length && offset < content.length) {
    const frame = frames.at(-1)!;
    const char = content[offset++];
    if (frame.kind === 'literal') {
      if (char === '\\') {
        offset++;
      } else if (char === frame.closing) {
        if (--frame.depth === 0) frames.pop();
      } else if (char === frame.opening) {
        frame.depth++;
      } else if (frame.interpolates && char === '#' && content[offset] === '{') {
        frames.push(interpolationFrame());
        offset++;
      }
      continue;
    }

    expression.lastIndex = offset - 1;
    const [token] = expression.exec(content)!;
    offset = expression.lastIndex;
    if (/^(?:[^\S\n]|#)/.test(token)) continue;
    if (token === '}' && --frame.depth === 0) {
      frames.pop();
      continue;
    }
    if (token === '{') frame.depth++;
    if (token === "'" || token === '"' || token === '`' || (token === '/' && frame.regexpExpected)) {
      frames.push(literalFrame(token, token !== "'"));
    } else if (token === '%' && frame.regexpExpected) {
      percent.lastIndex = offset - 1;
      const match = percent.exec(content);
      if (match) {
        frames.push(literalFrame(match[2], !/^[qwis]$/.test(match[1])));
        offset = percent.lastIndex;
      }
    }
    frame.regexpExpected = expectsRegexp(token, frame.previous);
    frame.previous = token;
  }
  return frames.length === 0 ? offset : undefined;
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
