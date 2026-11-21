export const opensGemfileBlock = (tokens: string[]): boolean =>
  opensNamespace(tokens) || tokens.includes('do') || (tokens[0] === 'def' && !isEndlessMethod(tokens)) ||
  /^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '');

export const gemfileStatementsFromTokens = (tokens: string[]): string[][] => {
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

export const hasGemfileBinding = (tokens: string[], name: string): boolean => {
  const statements = gemfileStatementsFromTokens(tokens);
  return hasMethodParameter(statements, name) || hasLocalBinding(statements, name);
};

const hasMethodParameter = (statements: string[][], name: string): boolean => {
  const blocks: (boolean | undefined)[] = [];
  statements.forEach((statement) => {
    if (statement[0] === 'end') blocks.pop();
    if (opensGemfileBlock(statement)) {
      blocks.push(statement[0] === 'def' ? methodDeclaresParameter(statement, name) : undefined);
    }
  });
  return blocks.filter((binding) => binding !== undefined).at(-1) === true;
};

const hasLocalBinding = (statements: string[][], name: string): boolean => {
  const tokens = statements.flatMap((statement) => statement[0] === 'def' ? [';'] : [...statement, ';']);
  let parameters = false;
  return tokens.some((token, index) => {
    const previous = tokens[index - 1];
    if (token === '|') parameters = !parameters && (tokens[index - 2] === 'do' || previous === '{');
    return token === name && (parameters ||
      (previous !== '.' && tokens[index + 1] === '=' && tokens[index + 2] !== '='));
  });
};

const methodDeclaresParameter = (tokens: string[], name: string): boolean => {
  const args = tokens.slice(tokens[2] === '.' ? 4 : 2);
  const parameterDepth = args[0] === '(' ? 1 : 0;
  let depth = 0;
  return args.some((token, index) => {
    if (['(', '[', '{'].includes(token)) depth++;
    if ([')', ']', '}'].includes(token)) depth--;
    return depth === parameterDepth && token === name &&
      (index === 0 || ['(', ',', '*', '&'].includes(args[index - 1]));
  });
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
