export const stripRubyComments = (content: string): string =>
  content.replace(/#[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (token) => token.startsWith('#') ? '' : token);

export const rubyRuntimeDependencies = (content: string): string[] => {
  const tokens = stripRubyComments(content).match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\w+|[^\s]/g) ?? [];
  return tokens.flatMap((token, index) => {
    if (!/^(?:add_dependency|add_runtime_dependency)$/.test(token)) return [];
    const name = tokens[index + (tokens[index + 1] === '(' ? 2 : 1)] ?? '';
    return /^['"]/.test(name) ? [name.slice(1, -1)] : [];
  });
};
