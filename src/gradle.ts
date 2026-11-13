export const stripGradleComments = (content: string): string => {
  const code = /\/\/[^\r\n]*|\/\*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^]/gy;
  const comment = /\/\*|\*\/|[^*/]+|[*/]/gy;
  let depth = 0;
  let index = 0;
  let result = '';
  while (index < content.length) {
    const pattern = depth > 0 ? comment : code;
    pattern.lastIndex = index;
    const token = pattern.exec(content)![0];
    index = pattern.lastIndex;
    const hidden = depth > 0 || token === '/*' || token.startsWith('//');
    if (token === '/*') depth++;
    else if (depth > 0 && token === '*/') depth--;
    result += hidden ? token.replace(/[^\r\n]/g, ' ') : token;
  }
  return result;
};
