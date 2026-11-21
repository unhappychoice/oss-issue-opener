export const gemfileScope = (tokens: string[]): 'isolated' | 'block' | 'control' | undefined => {
  if (opensNamespace(tokens) || (tokens[0] === 'def' && !isEndlessMethod(tokens))) return 'isolated';
  if (/^(if|unless|case|begin|while|until|for)$/.test(tokens[0] ?? '')) return 'control';
  return tokens.includes('do') ? 'block' : undefined;
};

export class GemfileStatements {
  private current: string[] = [];
  private depth = 0;

  constructor(private readonly onStatement: (tokens: string[]) => void) {}

  push(token: string): void {
    if (/^(?:[^\S\n]+|\\\r?\n)$/.test(token)) return;
    if ((token === '\n' || token === ';') && this.depth === 0 && this.current.at(-1) !== ',') {
      this.finish();
      return;
    }
    if (token === '\n') return;
    if (this.depth === 0 && token === '{' && this.current.length &&
      !['=', ',', '=>'].includes(this.current.at(-1)!)) {
      this.current.push('do');
      this.finish();
      return;
    }
    if (this.depth === 0 && token === '}') {
      this.finish();
      this.onStatement(['end']);
      return;
    }
    if (token === 'end' && this.depth === 0) this.finish();
    if (['(', '[', '{'].includes(token)) this.depth++;
    if ([')', ']', '}'].includes(token)) this.depth--;
    this.current.push(token);
    if ((token === 'do' || token === 'end') && this.depth === 0) this.finish();
  }

  finish(): void {
    if (this.current.length) this.onStatement(this.current);
    this.current = [];
  }
}

const opensNamespace = (tokens: string[]): boolean =>
  tokens.some((token, index) => (token === 'class' || token === 'module') &&
    index + 1 < tokens.length &&
    (index === 0 || tokens[index - 1] === '='));

const isEndlessMethod = (tokens: string[]): boolean => {
  let depth = 0;
  return tokens.some((token, index) => {
    if (token === '(') depth++;
    if (token === ')') depth--;
    const nameEnd = tokens[2] === '.' ? 4 : 2;
    return token === '=' && depth === 0 && (index === nameEnd || tokens[index - 1] === ')');
  });
};
