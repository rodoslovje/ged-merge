import type { GedNode } from "../gedcom/types";

/**
 * Test helper: where two record forests first differ — in any field of any
 * node, runtime annotations (`reshapedFrom`, `conc`) included, key order
 * aside — or undefined when they are the same. Stricter than comparing
 * serializations, which leave the annotations out.
 */
export function forestDiff(a: GedNode[], b: GedNode[]): string | undefined {
  if (a.length !== b.length) return `${a.length} vs ${b.length} records`;
  const stack: [GedNode, GedNode, string][] = a.map((n, i) => [n, b[i], `#${i}`]);
  while (stack.length) {
    const [x, y, at] = stack.pop()!;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === "children") continue;
      const [vx, vy] = [JSON.stringify((x as never)[k]), JSON.stringify((y as never)[k])];
      if (vx !== vy) return `${at} ${x.tag}.${k}: ${vx} vs ${vy}`;
    }
    if (x.children.length !== y.children.length) return `${at} ${x.tag}: ${x.children.length} vs ${y.children.length} children`;
    x.children.forEach((c, i) => stack.push([c, y.children[i], `${at}/${i}`]));
  }
  return undefined;
}
