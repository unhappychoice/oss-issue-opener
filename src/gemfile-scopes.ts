export const blockKind = (tokens: string[]): 'method' | 'namespace' | 'block' | undefined => {
  if (tokens[0] === 'def' && !isEndlessMethod(tokens)) return 'method';
  if (/^(class|module)$/.test(tokens[0] ?? '') ||
    tokens.some((token, index) => /^(class|module)$/.test(token) && tokens[index - 1] === '=')) return 'namespace';
  if (tokens.includes('do') || /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) return 'block';
  return undefined;
};

export const createGemfileStatementCollector = (onStatement: (tokens: string[]) => void) => {
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
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      onStatement(current);
      current = [];
    }
  };
  const finish = () => { if (current.length) onStatement(current); };
  return { push, finish };
};

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
