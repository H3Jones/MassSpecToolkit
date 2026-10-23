import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Atom,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  Layers3,
  Moon,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToolErrorBoundary } from "@/components/tool-error-boundary";
import { resolveRoute, subscribeToHashChange } from "@/lib/routes";
import { tools, toolHref } from "@/lib/tools";
import { createSpectrumImportStore } from "@/lib/spectrum-import";
import { SpectrumPreview } from "./components/spectrum-preview";

const ToolPage = lazy(() => import("@/components/tool-page"));
const SpectrumPage = lazy(() => import("@/components/spectrum-page"));

const repository = "https://github.com/H3Jones/MassSpecToolkit";
const documentation = `${repository}/tree/HEAD/packages/ms-toolkit#readme`;

function NavigationDropdown({
  label,
  active,
  children,
}: {
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className="nav-link group inline-flex items-center gap-1"
        data-active={active}
      >
        {label}
        <ChevronDown
          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={10}
          collisionPadding={8}
          className="z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function App() {
  const hash = useSyncExternalStore(subscribeToHashChange, () => window.location.hash);
  const route = resolveRoute(hash);
  const mainRef = useRef<HTMLElement>(null);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [themeError, setThemeError] = useState("");
  const [spectrumStore] = useState(createSpectrumImportStore);
  const spectrumState = useSyncExternalStore(spectrumStore.subscribe, spectrumStore.getSnapshot);

  useEffect(() => {
    const current = resolveRoute(hash);
    document.title =
      current.kind === "tool"
        ? `${current.tool.name} | MassSpecToolkit`
        : current.kind === "spectrum"
          ? "Spectrum inspector | MassSpecToolkit"
          : current.kind === "not-found"
            ? "Page not found | MassSpecToolkit"
            : "MassSpecToolkit | Mass spectrometry calculations";

    if (current.kind === "home" && hash && !hash.startsWith("#/")) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    } else {
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }, [hash]);

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
      <a
        href="#main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
          mainRef.current?.scrollIntoView();
        }}
      >
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
            <NavigationDropdown label="Spectra" active={route.kind === "spectrum"}>
              <DropdownMenu.Item asChild>
                <a
                  className="nav-menu-item"
                  href="#/spectrum"
                  aria-current={route.kind === "spectrum" ? "page" : undefined}
                >
                  <Layers3 className="size-4 shrink-0" aria-hidden="true" />
                  Spectrum inspector
                </a>
              </DropdownMenu.Item>
            </NavigationDropdown>
            <NavigationDropdown label="Toolkit" active={route.kind === "tool"}>
              {tools.map((tool) => (
                <DropdownMenu.Item key={tool.id} asChild>
                  <a
                    className="nav-menu-item"
                    href={toolHref(tool)}
                    aria-current={
                      route.kind === "tool" && route.tool.id === tool.id ? "page" : undefined
                    }
                  >
                    <tool.icon className="size-4 shrink-0" aria-hidden="true" />
                    {tool.name}
                  </a>
                </DropdownMenu.Item>
              ))}
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item asChild>
                <a className="nav-menu-item" href="#toolkit">
                  <ArrowRight className="size-4 shrink-0" aria-hidden="true" />
                  All tools
                </a>
              </DropdownMenu.Item>
            </NavigationDropdown>
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

      <main id="main" ref={mainRef} tabIndex={-1} className="min-h-[60vh] outline-none">
        {route.kind === "spectrum" ? (
          <ToolErrorBoundary key="spectrum" pageName="Spectrum inspector">
            <Suspense
              fallback={
                <p role="status" className="page-width py-16">
                  Loading spectrum inspector...
                </p>
              }
            >
              <SpectrumPage
                state={spectrumState}
                importFile={spectrumStore.importFile}
                cancelImport={spectrumStore.cancelImport}
                dark={dark}
              />
            </Suspense>
          </ToolErrorBoundary>
        ) : route.kind === "tool" ? (
          <ToolErrorBoundary key={route.tool.id}>
            <Suspense
              fallback={
                <p role="status" className="page-width py-16">
                  Loading calculator...
                </p>
              }
            >
              <ToolPage key={route.tool.id} tool={route.tool} />
            </Suspense>
          </ToolErrorBoundary>
        ) : route.kind === "not-found" ? (
          <section className="page-width py-16">
            <h1 className="text-3xl font-semibold">Page not found</h1>
            <p className="mt-4 text-muted-foreground">This page does not exist.</p>
            <Button asChild className="mt-6">
              <a href="#toolkit">Return to toolkit</a>
            </Button>
          </section>
        ) : (
          <>
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
                      <a href="#/spectrum">
                        Inspect a spectrum <ArrowRight className="ml-2" />
                      </a>
                    </Button>
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
                    Open a calculator to evaluate molecular formulas in your browser. Each tool uses
                    the same calculation core as the library web components.
                  </p>
                </div>
                <a
                  href={documentation}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  Component documentation <ArrowUpRight className="size-4" />
                </a>
              </div>
              <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                {tools.map((tool) => {
                  const { number, icon: Icon, name, description, example, detail } = tool;
                  return (
                    <Card
                      key={name}
                      className="tool-card gap-5 rounded-2xl bg-card py-6 shadow-none"
                    >
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
                          <Button asChild variant="outline" size="sm">
                            <a href={toolHref(tool)} aria-label={`Open ${name.toLowerCase()}`}>
                              Open tool <ArrowRight />
                            </a>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
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
                    Embed individual calculators in a web application using framework-independent
                    custom elements. The components use a shared Rust/WebAssembly core for
                    calculations and expose results through DOM events.
                  </p>
                  <ul className="mt-6 space-y-3 text-sm">
                    <li className="flex items-center gap-3">
                      <Code2 className="size-4 text-primary" /> Custom elements with TypeScript
                      interfaces.
                    </li>
                    <li className="flex items-center gap-3">
                      <Cpu className="size-4 text-primary" /> Rust calculations in a shared Web
                      Worker.
                    </li>
                    <li className="flex items-center gap-3">
                      <ShieldCheck className="size-4 text-primary" /> Toolkit calculations stay in
                      the browser.
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
                The public repository contains the calculation core, language bindings, web
                components, and tests. Report issues or propose changes on GitHub.
              </p>
              <Button asChild className="mt-6 h-10 px-4">
                <a href={repository}>
                  View repository <ChevronRight className="ml-1" />
                </a>
              </Button>
            </section>
          </>
        )}
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
