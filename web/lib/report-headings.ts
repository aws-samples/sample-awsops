// Stored legacy reports may prefix an intended subheading with another heading marker.
export function normalizeHeadings(md: string): string {
  return md.replace(/^(#{1,6})[ \t]+(#{1,6}[ \t])/gm, '$2');
}
