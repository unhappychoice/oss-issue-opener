export const gradleDependencies = (content: string): string[] => {
  const code = stripGradleComments(content);
  const strings = code.matchAll(/^\s*(?:implementation|api)\s*(?:\(\s*)?(['"])([^'"\r\n]+)\1/gm);
  const named = code.matchAll(/^\s*(?:implementation|api)\s*(?:\(\s*)?((?:\w+\s*[:=]\s*(['"])[^'"\r\n]*\2\s*,\s*)*\w+\s*[:=]\s*(['"])[^'"\r\n]*\3)/gm);
  return [
    ...Array.from(strings, ([, , coordinate]) => coordinate),
    ...Array.from(named, ([, declaration]) => {
      const fields = Object.fromEntries(Array.from(
        declaration.matchAll(/(\w+)\s*[:=]\s*(['"])([^'"\r\n]*)\2/g),
        ([, key, , value]) => [key, value]
      ));
      return fields.group && fields.name ? [`${fields.group}:${fields.name}`] : [];
    }).flat(),
  ];
};

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
