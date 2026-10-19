import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Atom,
  Braces,
  Check,
  ChevronRight,
  Code2,
  Cpu,
  FlaskConical,
  GitCompareArrows,
  Layers3,
  Moon,
  ShieldCheck,
  Sun,
  Waves,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const repository = "https://github.com/H3Jones/MassSpecToolkit";
const documentation = `${repository}/tree/HEAD/packages/ms-toolkit#readme`;

const tools = [
  {
    number: "01",
    icon: FlaskConical,
    name: "Ion calculator",
    description:
      "Calculate formula mass, mass-to-charge ratio (m/z), and degree of unsaturation for a specified charge.",
    example: "C6H12O6",
    detail: "Mass and m/z",
  },
  {
    number: "02",
    icon: GitCompareArrows,
    name: "Mass split",
    description:
      "Compare two molecular formulas and report the mass difference.",
    example: "C14H23S / C17H19",
    detail: "Formula comparison",
  },
  {
    number: "03",
    icon: Waves,
    name: "Fine isotope structure",
    description:
      "Calculate fine isotope distributions and display calculated peak patterns.",
    example: "C2H6O",
    detail: "Isotope distributions",
  },
];

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

function SpectrumPreview() {
  return (
    <div className="spectrum-window">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <div className="flex items-center gap-2.5 text-sm font-medium">
          <span className="size-2 rounded-full bg-primary" />
          Centroid mass spectrum
        </div>
        <Badge variant="secondary" className="font-mono text-[10px]">
          SPECTRUM
        </Badge>
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

function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [themeError, setThemeError] = useState("");

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
    try {
      localStorage.setItem("mst-theme", next ? "dark" : "light");
      setThemeError("");
    } catch (error) {
      console.warn("Unable to save theme preference.", error);
      setThemeError("Your theme changed, but this browser could not save the preference.");
    }
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="site-header">
        <div className="page-width flex min-h-20 flex-wrap items-center justify-between gap-3 py-3">
          <a
            href="#"
            aria-label="MassSpecToolkit home"
            className="flex items-center gap-2.5 font-semibold tracking-tight"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Atom className="size-5" />
            </span>
            <span>
              MassSpec<span className="text-muted-foreground">Toolkit</span>
            </span>
          </a>
          <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-5">
            <a className="nav-link" href="#toolkit">
              Toolkit
            </a>
            <a className="nav-link" href="#developers">
              Developers
            </a>
            <Button asChild variant="ghost" size="icon" aria-label="View source on GitHub">
              <a href={repository}>
                <Code2 />
              </a>
            </Button>
            <span className="h-5 w-px bg-border" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label="Dark mode"
              aria-pressed={dark}
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </nav>
        </div>
      </header>
      {themeError && (
        <p role="status" className="page-width py-2 text-sm text-destructive">
          {themeError}
        </p>
      )}

      <main id="main">
        <section className="hero-section">
          <div className="page-width grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.05fr_1fr] lg:gap-16 lg:py-28">
            <div>
              <Badge
                variant="outline"
                className="gap-2 border-primary/20 bg-primary/5 px-3 py-1.5 text-primary"
              >
                <span className="size-1.5 rounded-full bg-primary" />
                Mass spectrometry software
              </Badge>
              <h1 className="mt-7 text-5xl leading-[1.08] font-semibold tracking-[-0.055em] sm:text-6xl xl:text-7xl">
                Mass spectrometry
                <br />
                <span className="text-primary">calculations.</span>
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
                Calculate formula masses, compare molecular compositions, and model fine isotope
                distributions using a Rust calculation core compiled to WebAssembly.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild size="lg" className="h-11 px-5">
                  <a href="#toolkit">
                    View components <ArrowDown className="ml-2" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="lg" className="h-11 px-5">
                  <a href={repository}>
                    <Code2 className="mr-1" /> View on GitHub
                  </a>
                </Button>
              </div>
              <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-primary" /> Browser-based calculations
                </span>
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-primary" /> Public source
                </span>
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-primary" /> No server required
                </span>
              </div>
            </div>
            <SpectrumPreview />
          </div>
        </section>

        <div className="border-y bg-muted/30">
          <div className="page-width flex flex-wrap items-center justify-between gap-x-8 gap-y-5 py-6">
            <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Implementation
            </p>
            <div className="flex flex-wrap gap-6 text-sm font-medium sm:gap-10">
              <span className="flex items-center gap-2">
                <Cpu className="size-4 text-muted-foreground" /> Rust + WebAssembly
              </span>
              <span className="flex items-center gap-2">
                <Braces className="size-4 text-muted-foreground" /> TypeScript
              </span>
              <span className="flex items-center gap-2">
                <Layers3 className="size-4 text-muted-foreground" /> Web Components
              </span>
            </div>
          </div>
        </div>

        <section id="toolkit" className="page-width scroll-mt-24 py-20 sm:py-24">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <div>
              <p className="section-kicker">THE TOOLKIT</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Calculation components
              </h2>
              <p className="mt-4 max-w-xl leading-relaxed text-muted-foreground">
                The library provides the following web components. Dedicated calculator pages are
                planned; this site currently documents the available functionality.
              </p>
            </div>
            <a
              href={documentation}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              Component documentation <ArrowUpRight className="size-4" />
            </a>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {tools.map(({ number, icon: Icon, name, description, example, detail }) => (
              <Card key={name} className="tool-card gap-5 rounded-2xl bg-card py-6 shadow-none">
                <CardHeader className="gap-4 px-6">
                  <div className="flex items-center justify-between">
                    <span className="flex size-11 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
                      <Icon className="size-5" />
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{number}</span>
                  </div>
                  <div>
                    <CardTitle className="text-lg">{name}</CardTitle>
                    <CardDescription className="mt-3 text-sm leading-relaxed">
                      {description}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto px-6">
                  <div className="rounded-lg border bg-muted/40 px-3 py-3 font-mono text-sm">
                    {example}
                  </div>
                  <div className="mt-5 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{detail}</span>
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      Tool page planned
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="developers" className="scroll-mt-24 border-y bg-muted/30">
          <div className="page-width grid gap-10 py-20 sm:py-24 lg:grid-cols-2 lg:gap-20">
            <div>
              <p className="section-kicker">SOFTWARE INTEGRATION</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Web components.
                <br />
                Shared calculation core.
              </h2>
              <p className="mt-5 max-w-lg leading-relaxed text-muted-foreground">
                Embed individual calculators in a web application using framework-independent custom
                elements. The components use a shared Rust/WebAssembly core for calculations and
                expose results through DOM events.
              </p>
              <ul className="mt-6 space-y-3 text-sm">
                <li className="flex items-center gap-3">
                  <Code2 className="size-4 text-primary" /> Custom elements with TypeScript
                  interfaces.
                </li>
                <li className="flex items-center gap-3">
                  <Cpu className="size-4 text-primary" /> Rust calculations in a shared Web Worker.
                </li>
                <li className="flex items-center gap-3">
                  <ShieldCheck className="size-4 text-primary" /> Toolkit calculations stay in the
                  browser.
                </li>
              </ul>
              <Button asChild variant="outline" className="mt-8">
                <a href={documentation}>
                  Read the developer guide <ArrowRight className="ml-2" />
                </a>
              </Button>
            </div>
            <div className="min-w-0 self-center overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="flex items-center gap-2 border-b px-5 py-3 text-xs text-muted-foreground">
                <Code2 className="size-4" />
                <span>component-example.html</span>
                <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
                  HTML
                </Badge>
              </div>
              <pre className="overflow-x-auto p-6 font-mono text-xs leading-7 sm:text-sm">
                <code>
                  <span className="text-muted-foreground">
                    {"<!-- After importing the toolkit -->\n"}
                  </span>
                  <span className="text-primary">{"<ms-ion-calculator\n"}</span>
                  {'  formula="C6H12O6"\n  charge="1"\n'}
                  <span className="text-primary">
                    {"></ms-ion-calculator>\n\n<ms-fine-isotope-structure\n"}
                  </span>
                  {'  formula="C2H6O"\n'}
                  <span className="text-primary">{"></ms-fine-isotope-structure>"}</span>
                </code>
              </pre>
              <div className="border-t px-5 py-3 text-xs text-muted-foreground">
                Formula and charge attributes initialize the calculation inputs.
              </div>
            </div>
          </div>
        </section>

        <section className="page-width py-16 text-center sm:py-20">
          <Atom className="mx-auto size-7 text-primary" />
          <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
            Source code and development
          </h2>
          <p className="mx-auto mt-3 max-w-lg leading-relaxed text-muted-foreground">
            The public repository contains the calculation core, language bindings, web components,
            and tests. Report issues or propose changes on GitHub.
          </p>
          <Button asChild className="mt-6 h-10 px-4">
            <a href={repository}>
              View repository <ChevronRight className="ml-1" />
            </a>
          </Button>
        </section>
      </main>

      <footer className="border-t">
        <div className="page-width flex flex-wrap items-center justify-between gap-4 py-7 text-xs text-muted-foreground">
          <p>
            MassSpecToolkit{" "}
            <span className="mx-2" aria-hidden="true">
              /
            </span>{" "}
            Mass spectrometry calculations and visualization.
          </p>
          <div className="flex gap-5">
            <a href={documentation} className="hover:text-foreground">
              Documentation
            </a>
            <a href={repository} className="hover:text-foreground">
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}

export default App;
