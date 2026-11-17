import type { GedNode } from "../gedcom/types";

/** Depth-first visit of every node in a record forest. A visitor that returns
 *  `false` skips that node's subtree. */
export function walkNodes(records: GedNode[], visit: (node: GedNode) => void | boolean): void {
  const stack: GedNode[] = [...records];
  while (stack.length) {
    const node = stack.pop()!;
    if (visit(node) === false) continue;
    for (const child of node.children) stack.push(child);
  }
}
