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
      /** The node each one starts beside, or -1 (see createLayout3d). */
      via: Int32Array;
      layered: boolean;
    }
  | { type: "layered"; on: boolean };

/** While the layout settles: how far it has got, 0 to 1. Then, once, the
 *  settled positions — x, y, z per node, packed. The chart shows only those:
 *  watching the cloud unfold says nothing about the family. */
export type Layout3dReply =
  | { type: "progress"; share: number }
  | { type: "pos"; pos: Float32Array }
  | { type: "error"; message: string };
