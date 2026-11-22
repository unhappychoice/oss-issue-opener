const comment = /\/\*|\*\/|[^*/]+|[*/]/gy;

export const scanBlockComments = (
  content: string,
  code: (index: number) => string,
  onToken: (token: string, depth: number) => void
): void => {
  let depth = 0;
  let index = 0;
  while (index < content.length) {
    comment.lastIndex = index;
    const token = depth > 0 ? comment.exec(content)![0] : code(index);
    index += token.length;
    onToken(token, depth);
    if (token === '/*') depth++;
    else if (depth > 0 && token === '*/') depth--;
  }
};
