import { Layers3 } from "lucide-react";

const peaks = [
  [48, 19],
  [62, 42],
  [85, 26],
  [112, 59],
  [127, 32],
  [144, 18],
  [174, 168],
  [188, 38],
  [213, 22],
  [235, 45],
  [264, 112],
  [278, 25],
  [310, 36],
  [344, 78],
  [359, 17],
  [392, 29],
  [428, 47],
  [458, 16],
];

export function SpectrumPreview() {
  return (
    <div className="spectrum-window">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <span className="size-2 rounded-full bg-primary" />
          Centroid mass spectrum
        </div>
        <span className="rounded-md bg-secondary px-2 py-1 font-mono text-[10px] text-secondary-foreground">
          SPECTRUM
        </span>
      </div>
      <div className="px-5 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Schematic spectrum</p>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              Relative intensity versus m/z
            </p>
          </div>
          <span className="rounded-md border px-2 py-1 font-mono text-xs text-muted-foreground">
            m/z
          </span>
        </div>
        <svg
          viewBox="0 0 500 250"
          role="img"
          aria-labelledby="spectrum-title spectrum-description"
          className="mt-6 w-full overflow-visible"
        >
          <title id="spectrum-title">Illustrative centroid mass spectrum</title>
          <desc id="spectrum-description">
            A static illustration of discrete mass spectrum peaks. This is not a live calculation.
          </desc>
          {[40, 85, 130, 175, 220].map((y) => (
            <line
              key={y}
              x1="32"
              y1={y}
              x2="480"
              y2={y}
              className="stroke-border"
              strokeDasharray="3 5"
            />
          ))}
          <text x="5" y="44" className="chart-label">
            100
          </text>
          <text x="12" y="134" className="chart-label">
            50
          </text>
          <text x="19" y="224" className="chart-label">
            0
          </text>
          <line x1="32" y1="220" x2="480" y2="220" className="stroke-border" />
          {peaks.map(([x, height]) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1="220"
              y2={220 - height}
              className="stroke-primary"
              strokeWidth={height > 100 ? 3 : 2}
              strokeLinecap="round"
              opacity={height > 100 ? 1 : 0.55}
            />
          ))}
          <rect x="147" y="25" width="54" height="24" rx="6" className="fill-primary" />
          <text
            x="174"
            y="41"
            textAnchor="middle"
            className="fill-primary-foreground font-mono text-[11px]"
          >
            43.0
          </text>
          {[20, 40, 60, 80, 100].map((value, index) => (
            <text
              key={value}
              x={48 + index * 102}
              y="243"
              textAnchor="middle"
              className="chart-label"
            >
              {value}
            </text>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/40 px-5 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Layers3 className="size-3.5" /> Centroid spectrum
        </span>
        <span>Illustrative preview</span>
      </div>
    </div>
  );
}