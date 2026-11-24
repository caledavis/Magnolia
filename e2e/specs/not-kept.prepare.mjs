// Give the sample project a link between two items, as other programs
// write them and Magnolia can't keep.
export default function prepare(project, { qdpxTool }) {
  const qde = qdpxTool('get', project, 'Sample.qde')
  const link = '<Links><Link guid="B0000000-0000-4000-8000-000000000001" name="relates to"/></Links>'
  qdpxTool('put', project, 'Sample.qde', qde.replace('</Project>', link + '</Project>'))
}
