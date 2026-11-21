export const splitGemfileStatements = (tokens: string[]): string[][] => {
  const result: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  let blockParameters = false;
  tokens.forEach((token) => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if (blockParameters) {
      if (token === '|') {
        result.push([...current, token]);
        current = [];
        blockParameters = false;
      } else if (token !== '\n') {
        current.push(token);
      }
      return;
    }
    if (token === '|' && current.length === 0 && result.at(-1)?.at(-1) === 'do') {
      current.push(token);
      blockParameters = true;
      return;
    }
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) result.push(current);
      current = [];
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      result.push([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      if (current.length) result.push(current);
      result.push(['end']);
      current = [];
      return;
    }
    if (token === 'end' && depth === 0 && current.length) {
      result.push(current);
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      result.push(current);
      current = [];
    }
  });
  if (current.length) result.push(current);
  return result;
};

export const opensScope = (tokens: string[]): boolean =>
  tokens[0] !== '|' && (opensLocalScope(tokens) || tokens.includes('do') ||
    /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? ''));

export const opensLocalScope = (tokens: string[]): boolean =>
  (tokens[0] === 'def' && !isEndlessMethod(tokens)) ||
  tokens.some((token, index) => (token === 'class' || token === 'module') &&
    (index === 0 || tokens[index - 1] === '='));

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
