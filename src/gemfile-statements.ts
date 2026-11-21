export const readGemfileStatements = (onStatement: (tokens: string[]) => void) => {
  let current: string[] = [];
  let depth = 0;
  const finish = (): void => {
    if (current.length) onStatement(current);
    current = [];
  };
  const push = (token: string): void => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      finish();
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      onStatement([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      finish();
      onStatement(['end']);
      return;
    }
    if (token === 'end' && depth === 0) finish();
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) finish();
  };
  return { push, finish, currentTokens: () => current };
};

export const gemfileScopeKind = (tokens: string[]): 'isolated' | 'block' | 'shared' | undefined => {
  if (opensNamespace(tokens) || (tokens[0] === 'def' && !isEndlessMethod(tokens))) return 'isolated';
  if (/^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) return 'shared';
  if (tokens.includes('do')) return 'block';
  return undefined;
};

const opensNamespace = (tokens: string[]): boolean =>
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
