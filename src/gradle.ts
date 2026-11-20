import { scanBlockComments } from './block-comments.js';

export const gradleDependencies = (content: string): string[] => {
  const code = gradleDeclarations(stripGradleComments(content));
  const strings = code.flatMap((declaration) => Array.from(declaration.matchAll(/^\s*(?:implementation|api)\s*(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?(['"])([^'"\r\n]+)\1/g)));
  const named = code.flatMap((declaration) => Array.from(declaration.matchAll(/^\s*(?:implementation|api)\s*(?:\(\s*)?(?:(?:platform|enforcedPlatform)\s*\(\s*)?((?:\w+\s*[:=]\s*(['"])[^'"\r\n]*\2\s*,\s*)*\w+\s*[:=]\s*(['"])[^'"\r\n]*\3)/g)));
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

export const gradleCatalogAliases = (content: string): string[] =>
  gradleDeclarations(stripGradleComments(content)).flatMap((declaration) => {
    const match = declaration.match(/^(?:implementation|api)(?:\s*\(\s*|\s+)(?:(?:platform|enforcedPlatform)\s*\(\s*)?libs\.([\w]+(?:\.[\w]+)*)(?:\.get\(\s*\))?(?=[ \t]*(?:\)|[;{}\r\n]|$))/);
    return match ? [match[1]] : [];
  });

export const stripGradleComments = (content: string): string => {
  const code = /\/\/[^\r\n]*|\/\*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\s\S]/gy;
  let result = '';
  scanBlockComments(content, code, (token, depth) => {
    const hidden = depth > 0 || token === '/*' || token.startsWith('//');
    result += hidden ? token.replace(/[^\r\n]/g, ' ') : token;
  });
  return result;
};

const gradleDeclarations = (content: string): string[] => {
  const tokens = /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:^|[;{])\s*((?:implementation|api)\b)/gm;
  return Array.from(content.matchAll(tokens)).flatMap((match) =>
    match[1] ? [content.slice(match.index + match[0].length - match[1].length)] : []
  );
};
