import { scanBlockComments } from './block-comments.js';

// Match expression starts and the bare because argument so division stays visible as code.
const groovySlashyString = /\/(?![/*])(?:\\\/|\\(?!\/)|[^/\\])*\//;
const groovyDollarSlashyString = /\$\/(?:\$[/$]|\$(?![/$])|\/(?!\$)|[^/$])*\/\$/;

export const gradleDependencies = (content: string): string[] => {
  const code = gradleDeclarations(lexGradle(content, true));
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
  gradleDeclarations(lexGradle(content, true)).flatMap((declaration) => {
    const match = declaration.match(/^(?:implementation|api)(?:\s*\(\s*|\s+)(?:(?:platform|enforcedPlatform)\s*\(\s*)?libs\.([\w]+(?:\.[\w]+)*)(?:\.get\(\s*\))?(?=[ \t]*(?:\)|[;{}\r\n]|$))/);
    return match ? [match[1]] : [];
  });

export const stripGradleComments = (content: string): string => lexGradle(content, false);

const lexGradle = (content: string, maskSlashyStrings: boolean): string => {
  const code = new RegExp(
    /\/\/[^\r\n]*|\/\*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/.source
    + '|' + groovyDollarSlashyString.source + '|' + /\s+|\w+|[\s\S]/.source,
    'y'
  );
  const slashy = new RegExp(groovySlashyString.source, 'y');
  let previous = '';
  let separated = false;
  let result = '';
  scanBlockComments(content, (index) => {
    if (content[index] === '/' && (/^[(\[=,:;{~]$/.test(previous) || (previous === 'because' && separated))) {
      slashy.lastIndex = index;
      const token = slashy.exec(content);
      if (token) return token[0];
    }
    code.lastIndex = index;
    return code.exec(content)![0];
  }, (token, depth) => {
    const hidden = depth > 0 || token === '/*' || token.startsWith('//');
    const visible = hidden ? token.replace(/[^\r\n]/g, ' ') : token;
    if (/^\s/.test(visible)) {
      separated = true;
      if (previous === 'because' && /[^ \t]/.test(visible)) previous = '';
    } else {
      previous = token;
      separated = false;
    }
    const isSlashy = token.length > 1 && (token.startsWith('/') || token.startsWith('$/'));
    // Keep statement boundaries and offsets while hiding the contents of slashy strings.
    result += maskSlashyStrings && !hidden && isSlashy ? token.replace(/[^\r\n]/g, '#') : visible;
  });
  return result;
};

const gradleDeclarations = (content: string): string[] => {
  const tokens = new RegExp(
    /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/.source
    + '|' + /(?<=^|[;{])[^\S\r\n\u2028\u2029]*(?:(constraints\s*(?:\(\s*\)\s*)?\{)|((?:implementation|api)\b))|[{}]/.source,
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
