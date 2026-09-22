/** Encode a literal HCL quoted string, including HCL template introducers. */
export function hclString(value) {
  const escaped = String(value).replace(/["\\\u0000-\u001f]/g, (char) => {
    if (char === '"' || char === '\\') return '\\' + char;
    return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
  });
  return '"' + escaped.replace(/\$\{/g, '$$$${').replace(/%\{/g, '%%{') + '"';
}
