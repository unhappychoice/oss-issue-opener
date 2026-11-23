export const opensBlock = (tokens: string[]): boolean =>
  opensNamespace(tokens) || tokens.includes('do') || (tokens[0] === 'def' && !isEndlessMethod(tokens)) ||
  /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '');

export const gemfileStatements = (tokens: string[]): string[][] => {
  const result: string[][] = [];
  let current: string[] = [];
  let depth = 0;
  tokens.forEach((token) => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
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

export const opensNamespace = (tokens: string[]): boolean => {
  if (isNamespaceKeyword(tokens[0])) return true;
  let depth = 0;
  return tokens.some((token, index) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return depth === 0 && token === '=' && isNamespaceKeyword(tokens[index + 1]);
  });
};

const isNamespaceKeyword = (token?: string): boolean => token === 'class' || token === 'module';

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
