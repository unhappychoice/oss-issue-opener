import { scanBlockComments } from './block-comments.js';

// Match expression starts and the bare because argument so division stays visible as code.
const groovySlashyString = /(?<=[(\[=,:;{~]\s*|\bbecause[ \t]+)\/(?![/*])(?:\\\/|\\(?!\/)|[^/\\])*\//;
const groovyDollarSlashyString = /\$\/(?:\$[/$]|\$(?![/$])|\/(?!\$)|[^/$])*\/\$/;
const groovySlashyStrings = `${groovyDollarSlashyString.source}|${groovySlashyString.source}`;

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

export const stripGradleComments = (content: string): string => {
  const code = new RegExp(
    /\/\/[^\r\n]*|\/\*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/.source
    + '|' + groovySlashyStrings + '|' + /[\s\S]/.source,
    'gy'
  );
  let result = '';
  scanBlockComments(content, code, (token, depth) => {
    const hidden = depth > 0 || token === '/*' || token.startsWith('//');
    result += hidden ? token.replace(/[^\r\n]/g, ' ') : token;
  });
  return result;
};

const gradleDeclarations = (content: string): string[] => {
  const tokens = new RegExp(
    /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/.source
    + '|' + groovySlashyStrings + '|' + /(?<=^|[;{])\s*(?:(constraints\s*(?:\(\s*\)\s*)?\{)|((?:implementation|api)\b))|[{}]/.source,
    'gm'
  );
  const declarations: string[] = [];
  let constraintDepth = 0;
  for (const { 0: token, 1: constraint, 2: configuration, index } of content.matchAll(tokens)) {
    if (constraint || (token === '{' && constraintDepth > 0)) constraintDepth++;
    else if (token === '}') constraintDepth = Math.max(0, constraintDepth - 1);
    else if (configuration && constraintDepth === 0) {
      declarations.push(content.slice(index + token.length - configuration.length));
    }
  }
  return declarations;
};
