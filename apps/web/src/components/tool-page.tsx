import { createElement, lazy, Suspense } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { tools, toolHref, type Tool } from "@/lib/tools";

function Calculator({ tool }: { tool: Tool }) {
  return createElement(tool.tag, { ...tool.attributes, className: "tool-element" });
}

const calculators = {
  "ion-calculator": lazy(async () => {
    await import("ms-toolkit/ion-calculator");
    return { default: Calculator };
  }),
  "mass-split": lazy(async () => {
    await import("ms-toolkit/mass-split");
    return { default: Calculator };
  }),
  "fine-isotope-structure": lazy(async () => {
    await import("ms-toolkit/fine-isotope-structure");
    return { default: Calculator };
  }),
};

export default function ToolPage({ tool }: { tool: Tool }) {
  const Icon = tool.icon;
  const ToolCalculator = calculators[tool.id];

  return (
    <div className="page-width py-10 sm:py-14">
      <a
        href="#toolkit"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> All tools
      </a>
      <div className="mt-7 flex items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-primary/10 bg-primary/5 text-primary">
          <Icon className="size-6" />
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{tool.name}</h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">{tool.description}</p>
        </div>
      </div>

      <nav aria-label="Calculation tools" className="my-8 flex flex-wrap gap-2">
        {tools.map((candidate) => (
          <Button
            key={candidate.id}
            asChild
            variant={candidate.id === tool.id ? "default" : "outline"}
          >
            <a
              href={toolHref(candidate)}
              aria-current={candidate.id === tool.id ? "page" : undefined}
            >
              {candidate.name}
            </a>
          </Button>
        ))}
      </nav>

      <Card className="min-w-0 rounded-2xl shadow-none">
        <CardHeader>
          <CardTitle>Calculation</CardTitle>
          <p className="text-sm text-muted-foreground">
            The example is calculated on opening this page. Edit the inputs and submit to
            recalculate. Calculations run locally in your browser.
          </p>
        </CardHeader>
        <CardContent className="min-w-0">
          <Suspense fallback={<p role="status">Loading calculation component...</p>}>
            <ToolCalculator tool={tool} />
          </Suspense>
        </CardContent>
      </Card>

      <section aria-labelledby="calculation-notes" className="mt-8 max-w-3xl">
        <h2 id="calculation-notes" className="text-lg font-semibold">
          Inputs and interpretation
        </h2>
        <ul className="mt-4 list-disc space-y-3 pl-5 text-sm leading-relaxed text-muted-foreground">
          {tool.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <a
          href="https://github.com/H3Jones/MassSpecToolkit/tree/HEAD/packages/ms-toolkit#readme"
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          Component documentation <ArrowUpRight className="size-4" />
        </a>
      </section>
    </div>
  );
}
