export const stripRubyComments = (content: string): string =>
  content.replace(/#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (token) => token.startsWith('#') ? '' : token);
