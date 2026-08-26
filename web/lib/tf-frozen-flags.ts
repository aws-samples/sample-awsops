// Reads a Terraform variable's `default` value straight from committed .tf source — no
// terraform binary, no local (gitignored) tfvars file. Brace-matched so a nested `validation {}`
// block between the header and `default =` doesn't throw off which block we're reading.
export function variableDefault(tfText: string, name: string): string | null {
  const header = new RegExp(`variable\\s+"${name}"\\s*\\{`);
  const start = header.exec(tfText);
  if (!start) return null;

  const openAt = start.index + start[0].length - 1;
  let depth = 0;
  let i = openAt;
  for (; i < tfText.length; i += 1) {
    if (tfText[i] === '{') depth += 1;
    else if (tfText[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = tfText.slice(openAt + 1, i);

  const attr = /^\s*default\s*=\s*(\S+)/m.exec(body);
  return attr ? attr[1] : null;
}
