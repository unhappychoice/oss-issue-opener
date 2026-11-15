const comment = /\/\*|\*\/|[^*/]+|[*/]/gy;

export const scanBlockComments = (
  content: string,
  code: RegExp,
  onToken: (token: string, depth: number) => void
): void => {
  let depth = 0;
  let index = 0;
  while (index < content.length) {
    const pattern = depth > 0 ? comment : code;
    pattern.lastIndex = index;
    const token = pattern.exec(content)![0];
    index = pattern.lastIndex;
    onToken(token, depth);
    if (token === '/*') depth++;
    else if (depth > 0 && token === '*/') depth--;
  }
};
