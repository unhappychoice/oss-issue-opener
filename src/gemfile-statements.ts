export const gemfileScope = (tokens: string[]): 'local' | 'block' | 'control' | undefined => {
  if (opensNamespace(tokens) || (tokens[0] === 'def' && !isEndlessMethod(tokens))) return 'local';
  if (/^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) return 'control';
  if (tokens.includes('do')) return 'block';
  return undefined;
};

export const hasPutsParameter = (tokens: string[]): boolean => {
  if (tokens[0] !== 'def') return false;
  const nameEnd = methodNameEnd(tokens);
  const start = tokens[nameEnd] === '(' ? nameEnd + 1 : nameEnd;
  return declaresPutsParameter(tokens.slice(start));
};

export const declaresPutsParameter = (tokens: string[]): boolean => {
  let depth = 0;
  let atParameterStart = true;
  return tokens.some((token) => {
    if (depth === 0 && atParameterStart && token === 'puts') return true;
    if (depth === 0 && (token === '*' || token === '&') && atParameterStart) return false;
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    atParameterStart = depth === 0 && (token === ',' || token === ';');
    return false;
  });
};

export const gemfileStatementReader = (read: (statement: string[]) => void) => {
  let current: string[] = [];
  let depth = 0;
  const push = (token: string): void => {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if ((token === '\n' || token === ';') && depth === 0 && current.at(-1) !== ',') {
      if (current.length) read(current);
      current = [];
      return;
    }
    if (token === '\n') return;
    if (depth === 0 && token === '{' && current.length && !['=', ',', '=>'].includes(current.at(-1)!)) {
      read([...current, 'do']);
      current = [];
      return;
    }
    if (depth === 0 && token === '}') {
      if (current.length) read(current);
      read(['end']);
      current = [];
      return;
    }
    if (token === 'end' && depth === 0 && current.length) {
      read(current);
      current = [];
    }
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    current.push(token);
    if ((token === 'do' || token === 'end') && depth === 0) {
      read(current);
      current = [];
    }
  };
  return {
    push,
    inMethodHeader: () => current[0] === 'def',
    finish: () => { if (current.length) read(current); },
  };
};

const opensNamespace = (tokens: string[]): boolean => {
  if (isNamespaceKeyword(tokens[0])) return true;
  let depth = 0;
  return tokens.some((token, index) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return depth === 0 && token === '=' && isNamespaceKeyword(tokens[index + 1]);
  });
};

const isNamespaceKeyword = (token?: string): boolean => token === 'class' || token === 'module';

const methodNameEnd = (tokens: string[]): number => tokens[2] === '.' ? 4 : 2;

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  const nameEnd = methodNameEnd(tokens);
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
