import { createElement, useCallback, useState } from "react";
import { FileUp, Waves } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { spectrumReaders, type MeasuredPeak, type SpectrumDataset } from "@/lib/spectrum";
import type { SpectrumImportState } from "@/lib/spectrum-import";
import type { SpectrumIntensityMode } from "ms-toolkit/charts";
import type { MsMassSpectrum } from "ms-toolkit/mass-spectrum";
import type { MsTable, MsTableColumn } from "ms-toolkit/table";
import "ms-toolkit/mass-spectrum";
import "ms-toolkit/table";

const columns: MsTableColumn<MeasuredPeak>[] = [
  { accessorKey: "mz", header: "m/z" },
  { accessorKey: "intensity", header: "Original intensity" },
  {
    accessorKey: "relativeIntensity",
    header: "Relative intensity (%)",
    cell: ({ getValue }) => Number(getValue()).toPrecision(6),
  },
  {
    accessorKey: "signal_to_noise",
    header: "Signal-to-noise",
    cell: ({ getValue }) => (getValue() == null ? "Not available" : String(getValue())),
  },
];

function SpectrumInspection({ dataset, dark }: { dataset: SpectrumDataset; dark: boolean }) {
  const [renderError, setRenderError] = useState("");
  const [intensityMode, setIntensityMode] = useState<SpectrumIntensityMode>("relative");
  const onError = useCallback((event: Event) => {
    setRenderError((event as CustomEvent<Error>).detail.message);
  }, []);
  const spectrum = useCallback(
    (chartElement: MsMassSpectrum | null) => {
      if (!chartElement) return;
      chartElement.addEventListener("ms-error", onError);
      try {
        chartElement.data = dataset.chartPeaks;
      } catch (error) {
        setRenderError(error instanceof Error ? error.message : String(error));
      }
      return () => chartElement.removeEventListener("ms-error", onError);
    },
    [dataset, onError],
  );
  const table = useCallback(
    (tableElement: MsTable<MeasuredPeak> | null) => {
      if (!tableElement) return;
      tableElement.addEventListener("ms-error", onError);
      try {
        tableElement.columns = columns;
        tableElement.data = dataset.peaks;
      } catch (error) {
        setRenderError(error instanceof Error ? error.message : String(error));
      }
      return () => tableElement.removeEventListener("ms-error", onError);
    },
    [dataset, onError],
  );

  const { summary } = dataset;
  return (
    <div className="mt-6 grid min-w-0 gap-6">
      <Card className="min-w-0 shadow-none">
        <CardHeader>
          <CardTitle className="break-all">{dataset.filename}</CardTitle>
          <p className="text-sm text-muted-foreground">Loaded spectrum · {dataset.format}</p>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Peaks</dt>
              <dd className="mt-1 font-mono">{dataset.peaks.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">m/z range</dt>
              <dd className="mt-1 break-all font-mono">
                {summary.minimumMz} - {summary.maximumMz}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Base peak (original intensity)</dt>
              <dd className="mt-1 break-all font-mono">
                {summary.basePeak.mz} m/z · {summary.basePeak.intensity}
              </dd>
              {summary.basePeakCount > 1 && (
                <p className="mt-1 text-muted-foreground">
                  {summary.basePeakCount} peaks share the maximum; showing the first in file order.
                </p>
              )}
            </div>
          </dl>
        </CardContent>
      </Card>
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
              ? "Intensities are relative to the dataset's base peak (100%)."
              : "Intensities use the original values and units from the imported file, without normalization."}
          </p>
          <p className="text-sm text-muted-foreground">
            Zoom and pan to inspect the spectrum; press Home in the chart to reset, +/- to zoom, and
            arrow keys to inspect peaks. The peak list below always shows both intensity scales.
          </p>
        </CardHeader>
        <CardContent className="min-w-0">
          {createElement("ms-mass-spectrum", {
            ref: spectrum,
            className: "spectrum-chart",
            "chart-title": dataset.filename,
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
            Relative intensities use the entire spectrum, not just the visible rows.
          </p>
        </CardHeader>
        <CardContent className="min-w-0">
          {createElement("ms-table", {
            ref: table,
            className: "spectrum-table",
            "page-size": "10",
            "aria-label": `Peaks from ${dataset.filename}`,
          })}
        </CardContent>
      </Card>
    </div>
  );
}

export default function SpectrumPage({
  state,
  importFile,
  dark,
}: {
  state: SpectrumImportState;
  importFile: (file: File) => Promise<void>;
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
          <p className="text-sm text-muted-foreground">
            One spectrum at a time. A successful import replaces the current dataset.
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
              aria-describedby="spectrum-format spectrum-memory spectrum-performance"
              className="block w-full min-w-0 rounded-lg border bg-background p-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
          <div id="spectrum-format" className="space-y-1 text-sm text-muted-foreground">
            {spectrumReaders.map((reader) => (
              <p key={reader.id}>
                <strong>{reader.name}</strong>: {reader.description}
              </p>
            ))}
            <p>
              Blank lines are ignored. m/z must be positive; intensity and S/N must be nonnegative.
              All values must be finite.
            </p>
          </div>
          <p id="spectrum-memory" className="text-xs text-muted-foreground">
            The dataset stays loaded while you navigate the app. Refreshing or closing the page
            clears it.
          </p>
          <p id="spectrum-performance" className="text-xs text-muted-foreground">
            No fixed file-size limit is enforced. Large spectra may take time and memory to plot;
            selecting another file supersedes the result but does not stop work already running.
          </p>
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="break-words text-sm text-muted-foreground"
          >
            {(() => {
              switch (state.status) {
                case "importing":
                  return `Importing ${state.filename}...${state.dataset ? " The previous spectrum remains below." : ""}`;
                case "loaded":
                  return `Loaded ${state.dataset.filename}.`;
                case "empty":
                  return "Choose an ASC file to begin.";
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
