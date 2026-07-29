import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { exportCanvasSvg } from "./exportSvg";
import { exportChartGedcom } from "./exportGedcom";
import { ExportMenu, type ExportItem } from "./ExportMenu";
import { GedIcon, ImageIcon, PrinterIcon } from "./icons/FormatIcons";
import { SheetPrintDialog } from "./SheetPrintDialog";
import type { SheetChartSource } from "./sheetExport";

// The chart pages' Export menu with the standard items built in: the branch
// GEDCOM (first — the shareable format), then the canvas SVG and print-PDF.
// A page passes only what it supports — no `gedcom` on the Compare Tree
// (incoming-only people aren't in the main file), no `canvasRef` on the text
// report — plus any page-specific items (the report's TXT and print doc)
// appended after the standard ones.
//
// Printing always goes through the print dialog, whatever the chart: the paper
// is the one thing the app cannot guess, and a page sized to the diagram is a
// page no printer can make. The dialog offers the cut-into-sheets settings on
// top when the page hands it a tree that can be cut.

interface Props {
  /** Disable the whole menu while the chart hasn't been built yet. */
  disabled?: boolean;
  /** Download base name (chartSlug of the root/kind). */
  slug: string;
  /** Header title baked into the SVG / print-PDF export. */
  title?: string;
  /** Branch-GEDCOM export: the main dataset + the chart's people. */
  gedcom?: { ds: Dataset; personIds: string[] };
  /** The `.tree-canvas` element hosting the diagram SVG, for SVG/PDF export. */
  canvasRef?: React.RefObject<HTMLDivElement | null>;
  /** Let the print cut the chart into page-sized sheets: the layered charts
   *  (tidy tree and grid) can be. Radial, timeline and relationship diagrams
   *  don't split into rectangles, so they leave this out and print whole. */
  sheets?: SheetChartSource;
  /** Page-specific items appended after the standard ones. */
  extraItems?: ExportItem[];
}

export function ChartExportMenu({ disabled, slug, title = "", gedcom, canvasRef, sheets, extraItems }: Props) {
  const { t } = useTranslation();
  const [sheetDialog, setSheetDialog] = useState(false);
  const items: ExportItem[] = [];
  if (gedcom) {
    items.push({
      key: "ged",
      icon: <GedIcon />,
      label: t("export.gedcom", { count: gedcom.personIds.length }),
      title: t("tree.exportGedcom.tooltip"),
      onSelect: () => exportChartGedcom(gedcom.ds, gedcom.personIds, slug),
    });
  }
  if (canvasRef) {
    items.push(
      {
        key: "svg",
        icon: <ImageIcon />,
        label: t("export.svg"),
        title: t("tree.export.tooltip"),
        onSelect: () => exportCanvasSvg(canvasRef.current, slug, title),
      },
      {
        key: "pdf",
        icon: <PrinterIcon />,
        label: t("export.pdf"),
        title: t(sheets ? "export.sheets.tooltip" : "tree.exportPdf.tooltip"),
        onSelect: () => setSheetDialog(true),
      },
    );
  }
  if (extraItems) items.push(...extraItems);
  return (
    <>
      <ExportMenu disabled={disabled} items={items} />
      {sheetDialog && canvasRef && (
        <SheetPrintDialog
          source={sheets}
          canvasRef={canvasRef}
          opts={{ title, fileName: slug }}
          onClose={() => setSheetDialog(false)}
        />
      )}
    </>
  );
}
