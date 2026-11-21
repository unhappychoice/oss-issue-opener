import { isCompoundAssignment } from './gemfile-regexp.js';

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
  const root: BindingScope = { statements: [] };
  const scopes = [root];
  gemfileStatementsFromTokens(tokens).forEach((statement) => {
    const scope = scopes.at(-1) ?? root;
    const method = statement[0] === 'def';
    if (statement[0] === 'end') {
      scopes.pop();
      return;
    }
    if (!method) scope.statements.push(statement);
    if (!opensGemfileBlock(statement)) return;
    if (method || opensNamespace(statement)) {
      scopes.push({ statements: [], parameter: method && methodDeclaresParameter(statement, name) });
    } else if (statement.at(-1) === 'do' && !/^(while|until|for)$/.test(statement[0])) {
      scopes.push({ statements: [], parent: scope });
    } else {
      scopes.push(scope);
    }
  });
  for (let scope: BindingScope | undefined = scopes.at(-1) ?? root; scope; scope = scope.parent) {
    if (scope.parameter || hasLocalBinding(scope, name)) return true;
  }
  return false;
};

type BindingScope = {
  statements: string[][];
  parent?: BindingScope;
  parameter?: boolean;
};

const hasLocalBinding = ({ statements, parent }: BindingScope, name: string): boolean => {
  if (statements.some((statement) => assignsForTargets(statement, name) || assignsMultipleTargets(statement, name))) {
    return true;
  }
  const tokens = statements.flatMap((statement) => [...statement, ';']);
  const parameterEnd = parent && tokens[0] === '|' ? tokens.indexOf('|', 1) : -1;
  return tokens.some((token, index) => token === name &&
    (index < parameterEnd || (tokens[index - 1] !== '.' && assignsLocal(tokens, index))));
};

const assignsLocal = (tokens: string[], index: number): boolean => {
  const operator = tokens[index + 1];
  return isCompoundAssignment(operator) || (operator === '=' && tokens[index + 2] !== '=');
};

const assignsMultipleTargets = (statement: string[], name: string): boolean => {
  const assignment = statement.indexOf('=');
  if (assignment < 0 || statement[assignment + 1] === '=') return false;
  const targets = statement.slice(0, assignment);
  return targets.includes(',') && includesLocalTarget(targets, name);
};

const assignsForTargets = (statement: string[], name: string): boolean => {
  if (statement[0] !== 'for') return false;
  const separator = statement.indexOf('in', 1);
  return separator > 1 && includesLocalTarget(statement.slice(1, separator), name);
};

const includesLocalTarget = (targets: string[], name: string): boolean =>
  targets.every((token) => /^(?:\w+|[(),*.@$])$/.test(token)) &&
  targets.some((token, index) => token === name &&
    (index === 0 || ['(', ',', '*'].includes(targets[index - 1])) &&
    (index === targets.length - 1 || [')', ','].includes(targets[index + 1])));

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
