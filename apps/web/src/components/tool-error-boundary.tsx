import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export class ToolErrorBoundary extends Component<
  { children: ReactNode; pageName?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error) {
    console.error(`Unable to load ${this.props.pageName ?? "calculator"} page.`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="page-width py-16">
          <h1 className="text-3xl font-semibold">
            {this.props.pageName ?? "Calculator"} unavailable
          </h1>
          <p role="alert" className="mt-4 text-destructive">
            {this.props.pageName ?? "The calculator"} could not be loaded. Check your connection and
            reload the page.
          </p>
          <Button className="mt-6" onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <a href="#toolkit" className="ml-4 text-sm text-primary underline">
            Return to toolkit
          </a>
        </section>
      );
    }
    return this.props.children;
  }
}
