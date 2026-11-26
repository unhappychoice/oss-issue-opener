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

// Resumes scanning a block comment whose opening `/*` already consumed, returning the index
// just past its matching `*/` (or content.length if it never closes).
export const blockCommentEnd = (content: string, start: number): number => {
  comment.lastIndex = start;
  let depth = 1;
  for (let match = comment.exec(content); match; match = comment.exec(content)) {
    if (match[0] === '/*') depth++;
    if (match[0] === '*/' && --depth === 0) return comment.lastIndex;
  }
  return content.length;
};
