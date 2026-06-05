import type { GedNode } from "../gedcom/types";

/** Depth-first visit of every node in a record forest. */
export function walkNodes(records: GedNode[], visit: (node: GedNode) => void): void {
  const stack: GedNode[] = [...records];
  while (stack.length) {
    const node = stack.pop()!;
    visit(node);
    for (const child of node.children) stack.push(child);
  }
}
