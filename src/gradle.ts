import { scanBlockComments } from './block-comments.js';

// Match expression starts and the bare because argument so division stays visible as code.
const groovySlashyString = /\/(?![/*])(?:\\\/|\\(?!\/)|[^/\\])*\//;
const groovyDollarSlashyString = /\$\/(?:\$[/$]|\$(?![/$])|\/(?!\$)|[^/$])*\/\$/;

export const parseGradleDependencies = (content: string): { coordinates: string[]; aliases: string[] } =>
  collectGradleDependencies(lexGradle(content, true));

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

const collectGradleDependencies = (content: string): { coordinates: string[]; aliases: string[] } => {
  const tokens = new RegExp(
    /"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/.source
    + '|' + /(?<=^|[;{])[^\S\r\n\u2028\u2029]*(?:(constraints\s*(?:\(\s*\)\s*)?\{)|((?:implementation|api)\b))|[{}]/.source,
    'gm'
  );
  const argument = new RegExp(
    /(?:\s*\(\s*|\s+)(?:(?:platform|enforcedPlatform)\s*\(\s*)?/.source
    + '(?:' + /(?<quote>['"])(?<coordinate>[^'"\r\n]+)\k<quote>/.source
    + '|' + /(?<fields>(?:\w+\s*[:=]\s*(?<leadingQuote>['"])[^'"\r\n]*\k<leadingQuote>\s*,\s*)*\w+\s*[:=]\s*(?<lastQuote>['"])[^'"\r\n]*\k<lastQuote>)/.source
    + '|' + /libs\.(?<alias>\w+(?:\.\w+)*)(?:\.get\(\s*\))?(?=[ \t]*(?:\)|[;{}\r\n]|$))/.source
    + ')',
    'y'
  );
  const coordinates: string[] = [];
  const aliases: string[] = [];
  let constraintDepth = 0;
  for (const { 0: token, 1: constraint, 2: configuration, index } of content.matchAll(tokens)) {
    if (constraint || (token === '{' && constraintDepth > 0)) constraintDepth++;
    else if (token === '}') constraintDepth = Math.max(0, constraintDepth - 1);
    else if (configuration && constraintDepth === 0) {
      argument.lastIndex = index + token.length;
      const match = argument.exec(content);
      if (!match) continue;
      const { coordinate, fields, alias } = match.groups!;
      if (coordinate) coordinates.push(coordinate);
      else if (alias) aliases.push(alias);
      else {
        const { group, name } = Object.fromEntries(Array.from(
          fields.matchAll(/(\w+)\s*[:=]\s*(['"])([^'"\r\n]*)\2/g),
          ([, key, , value]) => [key, value]
        ));
        if (group && name) coordinates.push(`${group}:${name}`);
      }
    }
  }
  return { coordinates, aliases };
};
