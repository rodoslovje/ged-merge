import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildPublishedTree, defaultPublishOptions, type PublishOptions } from "./model";
import { hydrateTree } from "./hydrate";
import { collectMediaRefs } from "../gedcom/media";
import { folderOf, photoFolderCounts, photoSrc, photoUseOf, versionPhotos } from "./photos";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const NOW = new Date("2026-06-01");

// Janez (dead) has his own portrait, a group photo with the living Ana, and a
// photo with the long-dead Marko. Marko and Janez share a family photo; Ana and
// Janez's family photo has the living Ana in it. One photo is private, one a PDF.
const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1880
1 DEAT
2 DATE 1950
1 OBJE
2 FILE photos/janez.jpg
2 TITL Janez
1 OBJE @O1@
2 CROP
3 TOP 10
3 LEFT 20
3 WIDTH 30
3 HEIGHT 40
1 OBJE @O2@
2 CROP
3 TOP 1
3 LEFT 2
3 WIDTH 3
3 HEIGHT 4
1 OBJE @O3@
1 OBJE @O4@
1 FAMS @F1@
0 @I2@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1990
1 OBJE @O1@
1 FAMS @F1@
0 @I3@ INDI
1 NAME Marko /Novak/
1 SEX M
1 BIRT
2 DATE 1850
1 DEAT
2 DATE 1920
1 OBJE @O2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 OBJE @O5@
0 @O1@ OBJE
1 FILE group-with-ana.jpg
0 @O2@ OBJE
1 FILE marko-janez.png
2 TITL Marko and Janez
0 @O3@ OBJE
1 FILE secret.jpg
1 RESN privacy
0 @O4@ OBJE
1 FILE letter.pdf
0 @O5@ OBJE
1 FILE wedding.jpg
0 TRLR
`;

const ds = dataset(FILE);
const opts = (over: Partial<PublishOptions> = {}): PublishOptions => {
  const base = defaultPublishOptions("Novak", "sl");
  return { ...base, ...over, include: { ...base.include, photos: true, ...over.include } };
};
const site = (over: Partial<PublishOptions> = {}) => buildPublishedTree(ds, opts(over), "@I1@", NOW);
const person = (tree: ReturnType<typeof site>["tree"], given: string) => tree.people.find((p) => p.given === given)!;

describe("site photos", () => {
  it("leave out every photo a hidden person is on, and private ones", () => {
    const { tree, summary, files } = site();
    expect(files.map((f) => f.source).sort()).toEqual(["marko-janez.png", "photos/janez.jpg"]);
    // The group with Ana, the wedding of Ana's family, the private photo.
    expect(summary).toMatchObject({ photos: 2, photosWithheld: 3 });
    expect(tree.photos!.map((p) => p.path)).toEqual(files.map((f) => f.path));
  });

  it("give each published person their photos in order, with their region", () => {
    const { tree } = site();
    const janez = person(tree, "Janez");
    expect(janez.photos).toHaveLength(2);
    expect(janez.photos![1].crop).toEqual({ top: 1, left: 2, width: 3, height: 4 });
    const shared = janez.photos![1].photo;
    expect(person(tree, "Marko").photos).toEqual([{ photo: shared }]);
    expect(tree.photos!.find((p) => p.id === shared)).toMatchObject({ title: "Marko and Janez" });
    // Ana, published by her initials, has no gallery.
    expect(tree.people.find((p) => p.living)!.photos).toBeUndefined();
  });

  it("publish the living's photos when their details are published", () => {
    expect(site({ living: "all" }).summary).toMatchObject({ photos: 4, photosWithheld: 1 });
  });

  it("go nowhere unless chosen", () => {
    const { tree, files } = buildPublishedTree(ds, defaultPublishOptions("Novak", "sl"), "@I1@", NOW);
    expect(tree.photos).toBeUndefined();
    expect(files).toEqual([]);
  });

  it("read back as shared media with their crops", () => {
    const { tree } = site();
    const back = hydrateTree(tree);
    const janez = back.individuals.get(`@${person(tree, "Janez").id}@`)!;
    const refs = collectMediaRefs(janez.raw, back.records);
    const pathOf = (id: string) => tree.photos!.find((p) => p.id === id)!.path;
    expect(refs.map((r) => r.file)).toEqual(person(tree, "Janez").photos!.map((l) => pathOf(l.photo)));
    expect(refs[1].crop).toEqual({ top: 1, left: 2, width: 3, height: 4 });
  });
});

describe("photos by folder", () => {
  it("follow their folder's choice, else the nearest one above", () => {
    const folders = { records: "out", "records/matricula": "pages", "": "pages" } as const;
    expect(photoUseOf(folders, "records/familysearch/b.jpg")).toBe("out");
    expect(photoUseOf(folders, "records/matricula/marriage/a.jpg")).toBe("pages");
    expect(photoUseOf(folders, "portraits/c.jpg")).toBe("tray");
    // "" is the files directly in the media folder, not every folder.
    expect(photoUseOf(folders, "d.jpg")).toBe("pages");
    expect(folderOf("./portraits\\old/e.jpg")).toBe("portraits/old");
  });

  it("leave a folder out of the ZIP, or out of the front page's strip", () => {
    // janez.jpg sits in "photos", marko-janez.png in the media folder itself.
    const out = site({ photoFolders: { photos: "out" } });
    expect(out.files.map((f) => f.source)).toEqual(["marko-janez.png"]);
    expect(out.summary).toMatchObject({ photos: 1, photosWithheld: 3 });
    const pages = site({ photoFolders: { "": "pages" } });
    expect(pages.tree.photos!.map((p) => [p.path.endsWith(".png"), p.tray])).toEqual([[false, undefined], [true, false]]);
  });

  it("are counted by folder, without web links", () => {
    expect(photoFolderCounts(ds)).toEqual(new Map([["photos", 1], ["", 4]]));
  });
});

describe("the cover photo", () => {
  const coverOf = (r: ReturnType<typeof site>) => r.tree.photos!.find((p) => p.id === r.tree.cover);
  const inGalleries = (r: ReturnType<typeof site>, id: string) => r.tree.people.some((p) => p.photos?.some((l) => l.photo === id));

  it("goes in whoever is on it — the author's choice — but as the cover only", () => {
    const r = site({ cover: "group-with-ana.jpg" });
    const cover = coverOf(r)!;
    expect(cover).toMatchObject({ tray: false });
    expect(r.files.find((f) => f.path === cover.path)?.source).toBe("group-with-ana.jpg");
    expect(inGalleries(r, cover.id)).toBe(false);
    expect(r.summary).toMatchObject({ photos: 3, photosWithheld: 2 });
  });

  it("is an ordinary photo where it could go in anyway, and goes in from a folder left out", () => {
    const r = site({ cover: "marko-janez.png" });
    expect(inGalleries(r, r.tree.cover!)).toBe(true);
    const out = site({ cover: "photos/janez.jpg", photoFolders: { photos: "out" } });
    expect(coverOf(out)).toBeDefined();
    expect(inGalleries(out, out.tree.cover!)).toBe(false);
  });

  it("may be a photo nobody in the file is linked to, and never a document", () => {
    const r = site({ cover: "landscape.jpg" });
    expect(r.files.find((f) => f.path === coverOf(r)!.path)?.source).toBe("landscape.jpg");
    expect(site({ cover: "letter.pdf" }).tree.cover).toBeUndefined();
    expect(site({ include: { ...defaultPublishOptions("x", "sl").include, photos: false }, cover: "landscape.jpg" }).tree.cover).toBeUndefined();
  });
});

describe("versionPhotos", () => {
  it("puts each photo's file time in its address, and leaves the path alone", () => {
    const tree = { photos: [{ id: "o1", path: "photos/o1.jpg" }, { id: "o2", path: "photos/o2.png" }] } as Parameters<typeof versionPhotos>[0];
    const out = versionPhotos(tree, new Map([["photos/o1.jpg", Date.UTC(2025, 3, 5, 20, 53, 17)]]));
    const [one, two] = out.photos!;
    expect(one.path).toBe("photos/o1.jpg");
    expect(photoSrc(one)).toBe(`photos/o1.jpg?v=${(Date.UTC(2025, 3, 5, 20, 53, 17) / 1000).toString(36)}`);
    // A photo with no time read keeps its bare address.
    expect(photoSrc(two)).toBe("photos/o2.png");
    // Another time, another address.
    const later = versionPhotos(tree, new Map([["photos/o1.jpg", Date.UTC(2026, 10, 16)]]));
    expect(photoSrc(later.photos![0])).not.toBe(photoSrc(one));
  });
});
