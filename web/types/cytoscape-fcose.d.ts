// cytoscape-fcose ships no type declarations; it is a cytoscape extension registered via `cytoscape.use()`.
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const fcose: Ext;
  export default fcose;
}
