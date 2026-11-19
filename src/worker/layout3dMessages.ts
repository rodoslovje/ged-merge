// Messages between the 3D network chart and its layout worker
// (layout3d.worker.ts). The arrays go over as transferables.

export type Layout3dRequest =
  | {
      type: "init";
      n: number;
      /** Edge ends and rest lengths, one entry per edge. */
      ea: Int32Array;
      eb: Int32Array;
      len: Float32Array;
      gen: Float64Array;
      hops: Int32Array;
      trees: Int32Array;
      layered: boolean;
    }
  | { type: "layered"; on: boolean };

/** The positions after some steps: x, y, z per node, packed. `done` once the
 *  layout has cooled — no more messages until it is warmed again. */
export interface Layout3dPositions {
  type: "pos";
  pos: Float32Array;
  done: boolean;
}
