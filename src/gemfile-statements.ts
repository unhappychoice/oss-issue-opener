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
    const startsHashPattern = current.length === 1 && current[0] === 'in';
    if (depth === 0 && token === '{' && current.length && !startsHashPattern &&
      !['=', ',', '=>'].includes(current.at(-1)!)) {
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
    const lambda = statement.findIndex((token, index) =>
      token === '->' && (index === 0 || statement[index - 1] === '='));
    if (!method) scope.statements.push(lambda === -1 ? statement : statement.slice(0, lambda));
    if (!opensGemfileBlock(statement)) return;
    if (method || opensNamespace(statement)) {
      scopes.push({ statements: [], parameter: method && methodDeclaresParameter(statement, name) });
    } else if (statement.at(-1) === 'do' && !/^(while|until|for)$/.test(statement[0])) {
      const parameter = lambda !== -1 && declaresParameter(statement.slice(lambda + 1, -1), name);
      scopes.push({ statements: [], parent: scope, parameter });
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
  if (statements.some((statement) =>
    assignsForTargets(statement, name) || assignsMultipleTargets(statement, name) ||
    bindsPatternTarget(statement, name) || bindsRescueTarget(statement, name))) {
    return true;
  }
  const tokens = statements.flatMap((statement) => [...statement, ';']);
  const parameterEnd = parent && tokens[0] === '|' ? tokens.indexOf('|', 1) : -1;
  return tokens.some((token, index) => (token === name && index < parameterEnd) ||
    (!/^[.@$]$/.test(tokens[index - 1] ?? '') &&
      (token === `${name}=` || (token === name && assignsLocal(tokens, index)))));
};

const bindsRescueTarget = (statement: string[], name: string): boolean =>
  statement[0] === 'rescue' && statement.at(-2) === '=>' && statement.at(-1) === name;

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

const bindsPatternTarget = (statement: string[], name: string): boolean => {
  if (statement[0] !== 'in') return false;
  const [, pattern, next] = statement;
  if (pattern === name && (next === undefined || ['if', 'unless', 'then'].includes(next))) return true;
  if (!['[', '{'].includes(pattern)) return false;
  const delimiters = [pattern];
  for (let index = 2; index < statement.length; index++) {
    const token = statement[index];
    if (token === name && !delimiters.includes('(') &&
      isPatternBinding(statement, index, delimiters.at(-1))) return true;
    if (['[', '(', '{'].includes(token)) delimiters.push(token);
    if ([']', ')', '}'].includes(token)) delimiters.pop();
    if (delimiters.length === 0) return false;
  }
  return false;
};

const isPatternBinding = (statement: string[], index: number, delimiter: string | undefined): boolean => {
  const previous = statement[index - 1];
  const next = statement[index + 1];
  if (delimiter === '{') {
    if (previous === ':') return [',', '}'].includes(next);
    return ['{', ','].includes(previous) && next === ':' && [',', '}'].includes(statement[index + 2]);
  }
  return ['[', ',', '*'].includes(previous) && [',', ']'].includes(next);
};

const includesLocalTarget = (targets: string[], name: string): boolean =>
  targets.every((token) => /^(?:\w+|[(),*.@$])$/.test(token)) &&
  targets.some((token, index) => token === name &&
    (index === 0 || ['(', ',', '*'].includes(targets[index - 1])) &&
    (index === targets.length - 1 || [')', ','].includes(targets[index + 1])));

const methodDeclaresParameter = (tokens: string[], name: string): boolean =>
  declaresParameter(tokens.slice(methodNameEnd(tokens)), name);

const methodNameEnd = (tokens: string[]): number =>
  tokens[2] === '.' || tokens[2] === '::' ? 4 : 2;

const declaresParameter = (args: string[], name: string): boolean => {
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
    const nameEnd = methodNameEnd(tokens);
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
