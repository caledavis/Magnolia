// Stamp the project as saved by a newer Magnolia, in a format above this
// one's (crates/magnolia-core/src/qdpx/format.rs).
export default function prepare(project, { qdpxTool }) {
  qdpxTool('put', project, 'magnolia-format.json', JSON.stringify({ format: 999, savedBy: 'Magnolia 9.0.0' }))
}
