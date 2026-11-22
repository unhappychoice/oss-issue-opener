export const readStatements = (onStatement: (tokens: string[]) => void, onStart: (token: string) => void) => {
  let current: string[] = [];
  let depth = 0;
  const push = (token: string) => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) onStatement(current);
      current = [];
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      onStatement([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      if (current.length) onStatement(current);
      onStatement(['end']);
      current = [];
      return;
    }
    if (token === 'end' && depth === 0 && current.length) {
      onStatement(current);
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    if (current.length === 0) onStart(token);
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      onStatement(current);
      current = [];
    }
  };
  const finish = () => {
    if (current.length) onStatement(current);
  };
  return { push, finish };
};

export const opensBlock = (tokens: string[]): boolean =>
  opensNamespace(tokens) || tokens.includes('do') || (tokens[0] === 'def' && !isEndlessMethod(tokens)) ||
  /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '');

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
