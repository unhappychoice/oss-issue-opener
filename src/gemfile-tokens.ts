export const gemfileTokens = (content: string): string[] => {
  const pattern = new RegExp(tokenPattern, 'g');
  const pending: { delimiter: string; indented: boolean }[] = [];
  const tokens: string[] = [];
  let previous = '\n';
  let regexpExpected = true;
  let warnIsLocal = false;
  let warnArgumentExpected = false;
  let classHeader = false;
  let loopHeader = false;
  const scopes: { closing: 'end' | '}'; warnIsLocal?: boolean }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith('#') || token.startsWith('=begin')) continue;
    if ((token === '/' || token === '%') &&
      (regexpExpected || (warnArgumentExpected && startsCommandRegexp(content, match.index)))) {
      const end = regexpEnd(content, match.index);
      if (end !== undefined) {
        pattern.lastIndex = end;
        previous = content.slice(match.index, end);
        tokens.push(previous);
        regexpExpected = false;
        warnArgumentExpected = false;
        classHeader = false;
        continue;
      }
    }
    if (classHeader && token.startsWith('<<')) {
      pattern.lastIndex = match.index + 2;
      tokens.push('<<');
      classHeader = false;
      previous = '<<';
      regexpExpected = false;
      continue;
    }
    if (!isSpacing(token)) {
      const statementStart = /^(?:\n|;|do|\{|then|end)$/.test(previous);
      const opensNamespace = (statementStart || previous === '=') && /^(?:class|module)$/.test(token);
      if (token === 'def' && statementStart) {
        const method = methodParameters(content, pattern.lastIndex);
        if (!method.endless) {
          scopes.push({ closing: 'end', warnIsLocal });
          warnIsLocal = method.bindsWarn;
        }
      } else if (token === scopes.at(-1)?.closing && previous !== '.') {
        warnIsLocal = scopes.pop()?.warnIsLocal ?? warnIsLocal;
      } else if (token === '{' || (token === 'do' && !loopHeader)) {
        const bindsWarn = blockParametersBindWarn(content, pattern.lastIndex);
        const closing = token === '{' ? '}' : 'end';
        scopes.push(bindsWarn ? { closing, warnIsLocal } : { closing });
        warnIsLocal ||= bindsWarn;
      } else if (opensNamespace) {
        scopes.push({ closing: 'end', warnIsLocal });
        warnIsLocal = false;
      } else if (statementStart && /^(?:if|unless|case|begin|while|until|for)$/.test(token)) {
        scopes.push({ closing: 'end' });
      }
      if (statementStart) loopHeader = /^(?:while|until|for)$/.test(token);
      if (token === 'do') loopHeader = false;
      if (statementStart) warnIsLocal ||= multipleAssignmentBindsWarn(content, match.index);
      if (token === 'warn' && previous !== '.') {
        warnIsLocal ||= previous === 'in' || startsAssignment(content, pattern.lastIndex);
      }
      warnArgumentExpected = token === 'warn' && !warnIsLocal && regexpExpected;
      classHeader = opensNamespace && token === 'class';
      regexpExpected = expectsRegexpAfter(token, previous);
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

const tokenPattern = /(?<![^\n])=begin(?=[ \t\r\n\f\v]|$)[\s\S]*?(?:\n=end(?=[ \t\r\n\f\v]|$)[^\n]*|$)|#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|<<[-~]?(?:[A-Za-z_]\w*|'[^'\r\n]+'|"[^"\r\n]+"|`[^`\r\n]+`)|\\\r?\n|:\w+|\w+=(?=\s*\()|\w+[!?]?|=>|&&|\|\||[^\S\n]+|\n|./;

const isSpacing = (token: string): boolean => /^(?:[^\S\n]+|\\\r?\n)$/.test(token);

const methodParameters = (content: string, offset: number) => {
  const name = /[ \t]+(?:[\w!?]+(?:\.|::))*[^\s(;]+[ \t]*/y;
  name.lastIndex = offset;
  if (!name.exec(content)) return { endless: false, bindsWarn: false };
  const parenthesized = content[name.lastIndex] === '(';
  return readParameters(content, name.lastIndex + Number(parenthesized), parenthesized ? ')' : undefined);
};

const blockParametersBindWarn = (content: string, offset: number): boolean => {
  const opening = /\s*\|(?!\|)/y;
  opening.lastIndex = offset;
  return opening.test(content) && readParameters(content, opening.lastIndex, '|').bindsWarn;
};

const readParameters = (content: string, offset: number, closing?: ')' | '|') => {
  const parameters = new RegExp(tokenPattern, 'y');
  parameters.lastIndex = offset;
  let depth = 0;
  let bindsWarn = false;
  let atParameter = true;
  let match: RegExpExecArray | null;
  while ((match = parameters.exec(content)) !== null) {
    const token = match[0];
    if (isSpacing(token) || token.startsWith('#')) continue;
    if (depth === 0) {
      if (token === closing) {
        return { endless: closing === ')' && startsAssignment(content, parameters.lastIndex), bindsWarn };
      }
      if (!closing && /^(?:\n|;|end)$/.test(token)) break;
      if (closing !== '|' && token === '=' && atParameter) return { endless: true, bindsWarn };
      if (atParameter && token === 'warn') bindsWarn = true;
      if (!/^[*&]$/.test(token)) atParameter = token === ',' || (closing === '|' && token === ';');
    }
    if (/^[([{]$/.test(token)) depth++;
    if (/^[)\]}]$/.test(token)) depth--;
  }
  return { endless: false, bindsWarn };
};

const startsAssignment = (content: string, offset: number): boolean => {
  const assignment = /[^\S\n]*(?:\|\||&&|\*\*|<<|>>|[+*/%&|^\-])?=(?!=|>|~)/y;
  assignment.lastIndex = offset;
  return assignment.test(content);
};

const multipleAssignmentBindsWarn = (content: string, offset: number): boolean => {
  const targets = /([a-z_]\w*(?:[^\S\n]*,\s*[a-z_]\w*)+)[^\S\n]*=(?!=|>|~)/y;
  targets.lastIndex = offset;
  const match = targets.exec(content);
  return match !== null && /\bwarn\b/.test(match[1]);
};

const startsCommandRegexp = (content: string, offset: number): boolean =>
  /[^\S\n]/.test(content[offset - 1] ?? '') &&
  (content[offset] === '/' ? /[^\s=]/.test(content[offset + 1] ?? '') : content.startsWith('%r', offset));

const expectsRegexpAfter = (token: string, previous: string): boolean =>
  /^(?:\n|;|=|=>|~|\(|\[|\{|,|\?|:|&&|\|\|)$/.test(token) ||
  (previous !== '.' && /^(?:!|do|if|elsif|unless|when|in|then|else|return|and|or)$/.test(token));

const pairedDelimiters = new Map([['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']]);

const literalFrame = (content: string, start: number, inInterpolation: boolean) => {
  const opening = inInterpolation
    ? /\/|%([rqQwWiIxs]?)([^\p{L}\p{N}\s])/uy
    : /\/|%(r)([^\p{L}\p{N}\s])/uy;
  opening.lastIndex = start;
  const match = opening.exec(content);
  if (!match) return undefined;
  const delimiter = match[2] ?? '/';
  return {
    delimiter,
    closing: pairedDelimiters.get(delimiter) ?? delimiter,
    start: opening.lastIndex,
    regexp: match[1] === undefined || match[1] === 'r',
    interpolates: !/^[qwis]$/.test(match[1] ?? ''),
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
  const options = /[imxounes]*/y;
  let offset = initial.start;

  while (offset < content.length) {
    const frame = frames.at(-1)!;
    const char = content[offset];
    if (frame.braces === 0) {
      if (char === frame.closing && --frame.depth === 0) {
        offset++;
        if (frame.regexp) {
          options.lastIndex = offset;
          options.exec(content);
          offset = options.lastIndex;
        }
        frames.pop();
        if (frames.length === 0) return offset;
      } else if (char === '\\' || (frame.interpolates && content.startsWith('#{', offset))) {
        if (char === '#') {
          frame.braces = 1;
          frame.previous = '{';
          frame.regexpExpected = true;
        }
        offset += 2;
      } else {
        if (char === frame.delimiter && char !== frame.closing) frame.depth++;
        offset++;
      }
      continue;
    }

    expression.lastIndex = offset;
    const token = expression.exec(content)![0];
    if ((token === '/' || token === '%') && frame.regexpExpected) {
      const nested = literalFrame(content, offset, true);
      if (nested) {
        frames.push(nested);
        frame.previous = '//';
        frame.regexpExpected = false;
        offset = nested.start;
        continue;
      }
    }
    offset = expression.lastIndex;
    if (token.startsWith('#') || token.startsWith('=begin') || isSpacing(token)) continue;
    if (token === '{') frame.braces++;
    if (token === '}') frame.braces--;
    frame.regexpExpected = expectsRegexpAfter(token, frame.previous);
    frame.previous = token;
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
