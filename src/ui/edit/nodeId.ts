// Assign a monotonically increasing integer to each GedNode object so React
// keys remain stable across insertions and removals of sibling events.
const _nodeIds = new WeakMap<object, number>();
let _nextNodeId = 0;
export function nodeId(node: object): number {
  if (!_nodeIds.has(node)) _nodeIds.set(node, _nextNodeId++);
  return _nodeIds.get(node)!;
}
