import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Info, Waves, X } from "lucide-react";
import { Popover } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SpectrumReaderDescription } from "@/components/spectrum-reader-description";
import {
  loadSpectrumView,
  spectrumReaders,
  type MeasuredPeak,
  type SpectrumDataset,
  type SpectrumView,
} from "@/lib/spectrum";
import type { SpectrumImportState } from "@/lib/spectrum-import";
import type { SpectrumIntensityMode, TicPoint } from "ms-toolkit/charts";
import type { MsMassSpectrum } from "ms-toolkit/mass-spectrum";
import type { MsTic } from "ms-toolkit/tic";
import type { RetentionTimeRange } from "@/lib/spectrum-database";
import type { MsTable, MsTableColumn, MsTablePage, MsTablePageRequest } from "ms-toolkit/table";
import "ms-toolkit/mass-spectrum";
import "ms-toolkit/table";
import "ms-toolkit/tic";

const columns: MsTableColumn<MeasuredPeak>[] = [
  { accessorKey: "mz", header: "m/z", sortDescFirst: true },
  { accessorKey: "intensity", header: "Original intensity", sortDescFirst: true },
  {
    accessorKey: "relativeIntensity",
    header: "Relative intensity (%)",
    sortDescFirst: true,
    cell: ({ getValue }) => Number(getValue()).toPrecision(6),
  },
  {
    accessorKey: "signal_to_noise",
    header: "Signal-to-noise",
    sortDescFirst: true,
    cell: ({ getValue }) => (getValue() == null ? "Not available" : String(getValue())),
  },
  {
    accessorKey: "retention_time",
    header: "RT (input units)",
    sortDescFirst: true,
    cell: ({ getValue }) => (getValue() == null ? "Not available" : String(getValue())),
  },
];

function SpectrumInspection({ dataset, dark }: { dataset: SpectrumDataset; dark: boolean }) {
  const { metadata } = dataset;
  const [renderError, setRenderError] = useState("");
  const [intensityMode, setIntensityMode] = useState<SpectrumIntensityMode>("relative");
  const [view, setView] = useState<SpectrumView>(dataset);
  const [minimumRt, setMinimumRt] = useState(String(dataset.retentionTimeRange?.[0] ?? ""));
  const [maximumRt, setMaximumRt] = useState(String(dataset.retentionTimeRange?.[1] ?? ""));
  const [appliedRange, setAppliedRange] = useState(dataset.retentionTimeRange);
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState("");
  const [ticError, setTicError] = useState("");
  const tic = useRef<MsTic>(null);
  const queryRun = useRef(0);
  const tableRun = useRef(0);
  const [tablePage, setTablePage] = useState<MsTablePage<MeasuredPeak>>({
    rows: dataset.firstPage,
    rowCount: dataset.peakCount,
    pageIndex: 0,
    pageSize: 10,
    sorting: [],
  });
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState("");
  useEffect(
    () => () => {
      ++queryRun.current;
      ++tableRun.current;
    },
    [],
  );
  const queryRetentionTime = useCallback(
    async (range: RetentionTimeRange) => {
      const current = ++queryRun.current;
      setQuerying(true);
      setQueryError("");
      const startedAt = performance.now();
      try {
        const nextView = await loadSpectrumView(dataset.source, range);
        if (current !== queryRun.current) return;
        ++tableRun.current;
        setTableLoading(false);
        setTableError("");
        setTablePage({
          rows: nextView.firstPage,
          rowCount: nextView.peakCount,
          pageIndex: 0,
          pageSize: 10,
          sorting: [],
        });
        setView(nextView);
        setAppliedRange(range);
        setRenderError("");
        console.debug("[ms-toolkit] Spectrum RT query complete", {
          selectedPeakCount: nextView.peakCount,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        });
      } catch (error) {
        if (current === queryRun.current) {
          setQueryError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (current === queryRun.current) setQuerying(false);
      }
    },
    [dataset.source],
  );
  useEffect(() => {
    const element = tic.current;
    if (!element) return;
    const onSelect = (event: Event) => {
      const { retentionTime } = (event as CustomEvent<TicPoint>).detail;
      setMinimumRt(String(retentionTime));
      setMaximumRt(String(retentionTime));
      void queryRetentionTime([retentionTime, retentionTime]);
    };
    const onTicError = (event: Event) => setTicError((event as CustomEvent<Error>).detail.message);
    const onLoaded = () => setTicError("");
    element.addEventListener("ms-rt-select", onSelect);
    element.addEventListener("ms-error", onTicError);
    element.addEventListener("ms-viewport-loaded", onLoaded);
    try {
      const minimum = metadata.minimumRetentionTime;
      const maximum = metadata.maximumRetentionTime;
      if (minimum === null || maximum === null)
        throw new Error("Hyphenated metadata is missing RT bounds.");
      element.viewportSource = {
        rtRange: [minimum, maximum],
        query: (request) => dataset.source.queryTic(request),
      };
    } catch (error) {
      element.dispatchEvent(
        new CustomEvent("ms-error", {
          detail: error instanceof Error ? error : new Error(String(error)),
        }),
      );
    }
    return () => {
      element.removeEventListener("ms-rt-select", onSelect);
      element.removeEventListener("ms-error", onTicError);
      element.removeEventListener("ms-viewport-loaded", onLoaded);
    };
  }, [
    dataset.source,
    metadata.minimumRetentionTime,
    metadata.maximumRetentionTime,
    queryRetentionTime,
  ]);
  useEffect(() => {
    if (tic.current) tic.current.selectedRange = appliedRange;
  }, [appliedRange]);
  const onError = useCallback((event: Event) => {
    setRenderError((event as CustomEvent<Error>).detail.message);
  }, []);
  const onViewportLoaded = useCallback(() => setRenderError(""), []);
  const spectrum = useCallback(
    (chartElement: MsMassSpectrum | null) => {
      if (!chartElement) return;
      chartElement.addEventListener("ms-error", onError);
      chartElement.addEventListener("ms-viewport-loaded", onViewportLoaded);
      try {
        chartElement.viewportSource = {
          peakCount: view.peakCount,
          maximumMz: view.summary?.maximumMz ?? 0,
          minimumIntensity: view.summary?.minimumIntensity ?? 0,
          maximumIntensity: view.summary?.maximumIntensity ?? 0,
          async query(request) {
            const result = await dataset.source.queryChart(request, appliedRange);
            return {
              visibleCount: result.visibleCount,
              peaks: result.peaks.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
            };
          },
        };
      } catch (error) {
        setRenderError(error instanceof Error ? error.message : String(error));
      }
      return () => {
        chartElement.removeEventListener("ms-error", onError);
        chartElement.removeEventListener("ms-viewport-loaded", onViewportLoaded);
      };
    },
    [view, dataset.source, appliedRange, onError, onViewportLoaded],
  );
  const requestTablePage = useCallback(
    async (request: MsTablePageRequest) => {
      const current = ++tableRun.current;
      setTableLoading(true);
      setTableError("");
      try {
        const rows = await dataset.source.queryTablePage(request, appliedRange);
        if (current !== tableRun.current) return;
        setTablePage({ ...request, rows, rowCount: view.peakCount });
      } catch (error) {
        if (current === tableRun.current)
          setTableError(error instanceof Error ? error.message : String(error));
      } finally {
        if (current === tableRun.current) setTableLoading(false);
      }
    },
    [dataset.source, appliedRange, view.peakCount],
  );
  const onPageRequest = useCallback(
    (event: Event) => {
      void requestTablePage((event as CustomEvent<MsTablePageRequest>).detail);
    },
    [requestTablePage],
  );
  const table = useRef<MsTable<MeasuredPeak>>(null);
  useEffect(() => {
    const tableElement = table.current;
    if (!tableElement) return;
    tableElement.addEventListener("ms-error", onError);
    tableElement.addEventListener("ms-page-request", onPageRequest);
    try {
      tableElement.columns = columns;
      tableElement.page = tablePage;
    } catch (error) {
      tableElement.dispatchEvent(
        new CustomEvent("ms-error", {
          detail: error instanceof Error ? error : new Error(String(error)),
        }),
      );
    }
    return () => {
      tableElement.removeEventListener("ms-error", onError);
      tableElement.removeEventListener("ms-page-request", onPageRequest);
    };
  }, [tablePage, onError, onPageRequest]);

  const { summary } = view;
  return (
    <div className="mt-6 grid min-w-0 gap-6">
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle className="break-all">{metadata.filename}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Loaded spectrum · {dataset.format} ·{" "}
            {metadata.type === "Direct" ? "Direct infusion" : "Hyphenated"}
          </p>
          <p className="text-sm text-muted-foreground">
            {metadata.peakCount.toLocaleString()} measurements
          </p>
        </CardHeader>
        <CardContent>
          {metadata.type === "Hyphenated" && (
            <form
              className="mb-6 space-y-3 text-sm"
              aria-label="Retention time filter"
              aria-busy={querying}
              onSubmit={(event) => {
                event.preventDefault();
                if (!minimumRt.trim() || !maximumRt.trim()) {
                  setQueryError("Enter both RT bounds.");
                  return;
                }
                void queryRetentionTime([Number(minimumRt), Number(maximumRt)]);
              }}
            >
              <p id="rt-description" className="text-muted-foreground">
                RT range in file: {metadata.minimumRetentionTime} - {metadata.maximumRetentionTime}{" "}
                (original input units).
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1">
                  Minimum RT
                  <input
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={minimumRt}
                    onChange={(event) => setMinimumRt(event.target.value)}
                    aria-describedby="rt-description"
                    className="rounded-md border bg-background p-2"
                  />
                </label>
                <label className="grid gap-1">
                  Maximum RT
                  <input
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={maximumRt}
                    onChange={(event) => setMaximumRt(event.target.value)}
                    aria-describedby="rt-description"
                    className="rounded-md border bg-background p-2"
                  />
                </label>
                <button
                  type="submit"
                  disabled={querying}
                  className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
                >
                  {querying ? "Querying..." : "Apply RT range"}
                </button>
              </div>
              <p role="status" aria-live="polite">
                {querying
                  ? "Querying DuckDB. The previous view remains visible."
                  : `Showing ${view.peakCount.toLocaleString()} measurements.`}
              </p>
              {appliedRange && (
                <p className="text-muted-foreground">
                  Displayed RT: {appliedRange[0]} - {appliedRange[1]} (original input units).
                </p>
              )}
              {queryError && (
                <p role="alert" className="text-destructive">
                  Could not query the RT range: {queryError} The previous view is unchanged.
                </p>
              )}
            </form>
          )}
          <dl className="grid gap-5 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Peaks</dt>
              <dd className="mt-1 font-mono">{view.peakCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">m/z range</dt>
              <dd className="mt-1 break-all font-mono">
                {summary ? `${summary.minimumMz} - ${summary.maximumMz}` : "No peaks"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Base peak (original intensity)</dt>
              <dd className="mt-1 break-all font-mono">
                {summary
                  ? `${summary.basePeak.mz} m/z · ${summary.basePeak.intensity}`
                  : "No peaks"}
              </dd>
              {summary && summary.basePeakCount > 1 && (
                <p className="mt-1 text-muted-foreground">
                  {summary.basePeakCount} peaks share the maximum; showing the first in file order.
                </p>
              )}
            </div>
          </dl>
        </CardContent>
      </Card>
      {metadata.type === "Hyphenated" && (
        <Card className="min-w-0 shadow-none">
          <CardHeader>
            <CardTitle>Total ion chromatogram (TIC)</CardTitle>
            <p className="text-sm text-muted-foreground">
              Original intensities summed at each RT, in the file&apos;s input units. Click anywhere
              inside the plot to snap to the nearest displayed RT and show that slice in the
              spectrum and peak list. Use the numeric RT bounds above for an inclusive range. Zoom
              or drag the RT slider for finer detail; Home or Restore resets the axis. Arrow keys
              inspect displayed points; Enter or Space selects.
            </p>
          </CardHeader>
          <CardContent className="min-w-0">
            {ticError && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                Unable to display the TIC: {ticError}
              </p>
            )}
            {createElement("ms-tic", {
              ref: tic,
              className: "tic-chart",
              color: dark ? "#7da7ff" : "#2563eb",
            })}
          </CardContent>
        </Card>
      )}
      {renderError && (
        <p role="alert" className="break-words text-sm text-destructive">
          Unable to display the spectrum or table: {renderError}
        </p>
      )}
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle>Mass spectrum</CardTitle>
          <fieldset aria-describedby="intensity-description" className="mt-2 text-sm">
            <legend className="mb-2 font-medium">Intensity scale</legend>
            <div className="flex flex-wrap gap-4">
              {(["relative", "absolute"] as const).map((mode) => (
                <label key={mode} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="spectrum-intensity"
                    value={mode}
                    checked={intensityMode === mode}
                    onChange={() => setIntensityMode(mode)}
                    className="accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                  {mode === "relative" ? "Relative (%)" : "Absolute (original units)"}
                </label>
              ))}
            </div>
          </fieldset>
          <p id="intensity-description" className="text-sm text-muted-foreground">
            {intensityMode === "relative"
              ? "Intensities are relative to the selected spectrum's base peak (100%)."
              : "Intensities use the original values and units from the imported file, without normalization."}
          </p>
          <p className="text-sm text-muted-foreground">
            Use the chart&apos;s built-in zoom, undo, and restore controls; Home also restores both
            axes. Press +/- to zoom m/z and use the arrow keys to inspect peaks. <br /> The peak
            list below includes both original and relative intensities regardless of the selected
            chart scale.
          </p>
        </CardHeader>
        <CardContent className="min-w-0">
          {createElement("ms-mass-spectrum", {
            ref: spectrum,
            className: "spectrum-chart",
            "chart-title": metadata.filename,
            "intensity-mode": intensityMode,
            labels: "false",
            color: dark ? "#7da7ff" : "#2563eb",
          })}
        </CardContent>
      </Card>
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle>Peak list</CardTitle>
          <p className="text-sm text-muted-foreground">
            Original file order. Use column headings to sort; sorting does not change the chart.
            Relative intensities use all peaks in the selected RT interval (or the entire spectrum
            without RT), not just the visible rows. Missing values sort last.
          </p>
        </CardHeader>
        <CardContent className="min-w-0">
          <p role="status" aria-live="polite" className="mb-2 text-sm">
            {tableLoading ? "Loading peaks. The previous table page remains visible." : ""}
          </p>
          {tableError && (
            <p role="alert" className="mb-2 text-sm text-destructive">
              Could not load the table page: {tableError} The previous page is unchanged.
            </p>
          )}
          {createElement("ms-table", {
            ref: table,
            className: "spectrum-table",
            "page-size": "10",
            "aria-label": `Peaks from ${metadata.filename}`,
            loading: tableLoading ? "" : undefined,
          })}
        </CardContent>
      </Card>
    </div>
  );
}

export default function SpectrumPage({
  state,
  importFile,
  cancelImport,
  dark,
}: {
  state: SpectrumImportState;
  importFile: (file: File) => Promise<void>;
  cancelImport: () => void;
  dark: boolean;
}) {
  return (
    <div className="page-width min-w-0 py-10 sm:py-14">
      <div className="mb-8 flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
          <Waves className="size-6" />
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Spectrum inspector</h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">
            Import a measured centroid peak list to explore its spectrum and numerical data. Files
            stay in your browser.
          </p>
        </div>
      </div>
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileUp className="size-5" /> Import spectrum
          </CardTitle>
          <p id="spectrum-memory" className="text-sm text-muted-foreground">
            Upload a mass spectrum or a hyphenated data set. Measurements are held in a local,
            in-memory database while you navigate the app. Refreshing or closing the page clears it
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label htmlFor="spectrum-file" className="mb-2 block text-sm font-medium">
              Spectrum file
            </label>
            <input
              id="spectrum-file"
              type="file"
              accept={spectrumReaders.flatMap((reader) => reader.extensions).join(",")}
              aria-describedby="spectrum-format spectrum-memory"
              className="block w-full min-w-0 rounded-lg border bg-background p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
          <div id="spectrum-format" className="space-y-1 text-sm text-muted-foreground">
            <p>Supported spectrum file formats:</p>
            {spectrumReaders.map((reader) => (
              <div key={reader.id} className="flex flex-wrap items-baseline gap-x-2">
                <p>
                  <strong>{reader.name}</strong>: {reader.short}
                </p>
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      aria-label={`More info about the ${reader.name} reader`}
                    >
                      <Info aria-hidden="true" /> More info
                    </Button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      align="start"
                      sideOffset={8}
                      collisionPadding={16}
                      aria-labelledby={`reader-${reader.id}-title`}
                      aria-describedby={`reader-${reader.id}-description`}
                      className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-md"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 id={`reader-${reader.id}-title`} className="font-medium">
                          {reader.name} reader
                        </h3>
                        <Popover.Close asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Close reader information"
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </Popover.Close>
                      </div>
                      <div
                        id={`reader-${reader.id}-description`}
                        className="space-y-3 leading-relaxed [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5"
                      >
                        <SpectrumReaderDescription readerId={reader.id} />
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              </div>
            ))}
          </div>
          {state.status === "importing" && (
            <div className="flex items-center gap-3">
              <progress
                aria-label="Spectrum import progress"
                max={state.progress?.totalBytes || 1}
                value={
                  state.progress && state.progress.phase !== "initializing"
                    ? state.progress.bytesRead
                    : undefined
                }
                className="h-2 min-w-0 flex-1 accent-primary"
              />
              <button
                type="button"
                onClick={cancelImport}
                className="rounded-md border px-3 py-2 text-sm"
              >
                Cancel import
              </button>
            </div>
          )}
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="break-words text-sm text-muted-foreground"
          >
            {(() => {
              switch (state.status) {
                case "importing": {
                  const progress = state.progress;
                  const detail =
                    !progress || progress.phase === "initializing"
                      ? "Initializing database..."
                      : progress.phase === "finalizing"
                        ? "Finalizing database and preparing the first view..."
                        : `${Math.floor((progress.bytesRead / Math.max(1, progress.totalBytes)) * 100)}% read; ${progress.peakCount.toLocaleString()} measurements parsed.`;
                  return `Importing ${state.filename}: ${detail}${state.dataset ? " The previous spectrum remains below." : ""}`;
                }
                case "cancelled":
                  return `Cancelled import of ${state.filename}.${state.dataset ? " The previous spectrum is unchanged." : " Choose a file to try again."}`;
                case "loaded":
                  return `Loaded ${state.dataset.metadata.filename}.`;
                case "empty":
                  return "Choose a text peak list to begin.";
                default:
                  return "";
              }
            })()}
          </p>
          {state.status === "error" && (
            <div role="alert" className="break-words text-sm text-destructive">
              <p>
                Could not import {state.filename}: {state.error.message}
              </p>
              {state.dataset && <p className="mt-1">The previous spectrum is unchanged.</p>}
            </div>
          )}
        </CardContent>
      </Card>
      {state.dataset && (
        <SpectrumInspection key={state.dataset.id} dataset={state.dataset} dark={dark} />
      )}
    </div>
  );
}
