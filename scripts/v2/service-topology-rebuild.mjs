// Build the entry with npm run build:service-topology in web/ before running on a private host.
if (process.argv.length !== 3 || process.argv[2] !== '--publish-host') {
  console.error('Usage: node scripts/v2/service-topology-rebuild.mjs --publish-host');
  process.exitCode = 1;
} else {
  try {
    const { publishHost } = await import('../../web/.service-topology/publisher.mjs');
    const publication = await publishHost();
    console.log(JSON.stringify(publication));
    if (publication.partialInputs) process.exitCode = 2;
  } catch {
    console.error('Service topology publication failed. Verify bundle, role, schema and source state.');
    process.exitCode = 1;
  }
}
