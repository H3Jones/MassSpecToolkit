import {
  constructTable,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
  type Table,
} from "@tanstack/table-core";
import { flexRender } from "@tanstack/table-core/flex-render";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";

export type MsTableRow = Record<string, unknown>;

export interface MsTablePageRequest {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly sorting: readonly { readonly id: string; readonly desc: boolean }[];
}

/** Controlled server-side page; requests dispatch `ms-page-request` without replacing old rows. */
export interface MsTablePage<TData extends MsTableRow = MsTableRow> extends MsTablePageRequest {
  readonly rows: readonly TData[];
  readonly rowCount: number;
}

const features = tableFeatures({
  coreReactivityFeature: storeReactivityBindings(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type MsTableColumn<TData extends MsTableRow = MsTableRow> = ColumnDef<
  typeof features,
  TData
>;

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host {
      display: block;
      min-width: 0;
      color: inherit;
      font: inherit;
      --ms-table-border: color-mix(in srgb, currentColor 14%, transparent);
      --ms-table-header: color-mix(in srgb, currentColor 5%, transparent);
    }
    [hidden] { display: none !important; }
    .table-scroll {
      overflow-x: auto;
      border: 1px solid var(--ms-table-border);
      border-radius: 0.65rem;
    }
    table { width: max-content; min-width: 100%; table-layout: fixed; border-collapse: collapse; text-align: left; }
    th, td { padding: 0.7rem 0.9rem; border-bottom: 1px solid var(--ms-table-border); }
    th { background: var(--ms-table-header); font-size: 0.85em; font-weight: 600; white-space: nowrap; }
    td { white-space: nowrap; }
    th button {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: inherit;
      cursor: pointer;
    }
    th button:focus-visible, button:focus-visible, select:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
    .sort-indicator {
      display: inline-grid;
      width: 0.7rem;
      height: 0.7rem;
      place-items: center;
      opacity: 0.35;
    }
    .sort-indicator::before {
      width: 0;
      height: 0;
      border-right: 0.25rem solid transparent;
      border-bottom: 0.35rem solid currentColor;
      border-left: 0.25rem solid transparent;
      content: "";
    }
    .sort-indicator[data-direction="desc"]::before { transform: rotate(180deg); }
    .sort-indicator[data-direction="asc"], .sort-indicator[data-direction="desc"] { opacity: 1; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: var(--ms-table-header); }
    .empty { padding: 1.5rem; color: color-mix(in srgb, currentColor 65%, transparent); text-align: center; }
    .pagination {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0.65rem;
      margin-top: 0.75rem;
      font-size: 0.875em;
    }
    .pagination label { display: inline-flex; align-items: center; gap: 0.4rem; }
    .pagination button, .pagination select {
      padding: 0.35rem 0.55rem;
      border: 1px solid var(--ms-table-border);
      border-radius: 0.4rem;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    .pagination button:disabled { cursor: not-allowed; opacity: 0.45; }
    .status { margin: 0; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .range, .page-range { display: inline-block; text-align: right; }
    .error { margin: 0.5rem 0; color: #b91c1c; }
    @media (max-width: 32rem) {
      th, td { padding: 0.55rem 0.65rem; }
      .pagination { justify-content: flex-start; }
    }
  </style>
  <div class="table-scroll" part="container">
    <table part="table">
      <colgroup part="columns"></colgroup>
      <thead part="head"></thead>
      <tbody part="body"></tbody>
    </table>
  </div>
  <div class="pagination" part="pagination">
    <label>Rows per page
      <select part="page-size" aria-label="Rows per page">
        <option value="10">10</option>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
    </label>
    <p class="status" part="status" aria-live="polite"></p>
    <button type="button" part="previous" aria-label="Previous page">Previous</button>
    <button type="button" part="next" aria-label="Next page">Next</button>
  </div>
  <p class="error" part="error" role="alert" hidden></p>
`;

/**
 * `<ms-table page-size="10" aria-label="Isotope peaks"></ms-table>`
 * Set `columns` to TanStack Table column definitions and `data` to row objects.
 * Column headers are sortable; the footer controls client-side pagination.
 * Set `page` instead of `data` for controlled database sorting/pagination.
 * Handle `ms-page-request` (detail: MsTablePageRequest) and apply `page` on success.
 * The `loading` attribute disables controls while retaining the current page.
 * Rendering errors dispatch `ms-error` (detail: Error).
 */
export class MsTable<TData extends MsTableRow = MsTableRow> extends HTMLElement {
  static observedAttributes = ["page-size", "aria-label", "loading"];

  #data: TData[] = [];
  #columns: MsTableColumn<TData>[] = [];
  #table?: Table<typeof features, TData>;
  #container!: HTMLElement;
  #columnGroup!: HTMLTableColElement;
  #head!: HTMLTableSectionElement;
  #body!: HTMLTableSectionElement;
  #tableElement!: HTMLTableElement;
  #pagination!: HTMLElement;
  #pageSizeSelect!: HTMLSelectElement;
  #status!: HTMLElement;
  #error!: HTMLElement;
  #previousButton!: HTMLButtonElement;
  #nextButton!: HTMLButtonElement;
  #page?: MsTablePage<TData>;

  get page(): MsTablePage<TData> | undefined {
    return this.#page;
  }

  set page(page: MsTablePage<TData> | undefined) {
    if (
      page &&
      (!Number.isSafeInteger(page.pageIndex) ||
        page.pageIndex < 0 ||
        !Number.isSafeInteger(page.pageSize) ||
        page.pageSize < 1 ||
        !Number.isSafeInteger(page.rowCount) ||
        page.rowCount < 0 ||
        !Array.isArray(page.rows) ||
        page.rows.length > page.pageSize ||
        !Array.isArray(page.sorting))
    ) {
      throw new TypeError("A table page must provide rows, a row count, pagination, and sorting.");
    }
    this.#validateRows(page?.rows ?? []);
    this.#page = page;
    this.#data = page ? [...page.rows] : [];
    this.#updateTable();
  }

  get data(): readonly TData[] {
    return [...this.#data];
  }

  set data(rows: readonly TData[]) {
    this.#validateRows(rows);
    this.#page = undefined;
    this.#data = [...rows];
    this.#updateTable();
  }

  #validateRows(rows: readonly TData[]): void {
    if (!Array.isArray(rows)) throw new TypeError("Table data must be an array of row objects.");
    if (rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
      throw new TypeError("Each table row must be an object.");
    }
  }

  get columns(): readonly MsTableColumn<TData>[] {
    return [...this.#columns];
  }

  set columns(columns: readonly MsTableColumn<TData>[]) {
    if (!Array.isArray(columns)) throw new TypeError("Table columns must be an array.");
    this.#columns = [...columns];
    this.#updateTable();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#container = root.querySelector<HTMLElement>("[part=container]")!;
      this.#tableElement = root.querySelector<HTMLTableElement>("[part=table]")!;
      this.#columnGroup = root.querySelector<HTMLTableColElement>("[part=columns]")!;
      this.#head = root.querySelector<HTMLTableSectionElement>("[part=head]")!;
      this.#body = root.querySelector<HTMLTableSectionElement>("[part=body]")!;
      this.#pagination = root.querySelector<HTMLElement>("[part=pagination]")!;
      this.#pageSizeSelect = root.querySelector<HTMLSelectElement>("[part=page-size]")!;
      this.#status = root.querySelector<HTMLElement>("[part=status]")!;
      this.#error = root.querySelector<HTMLElement>("[part=error]")!;
      this.#previousButton = root.querySelector<HTMLButtonElement>("[part=previous]")!;
      this.#nextButton = root.querySelector<HTMLButtonElement>("[part=next]")!;
      this.#pageSizeSelect.addEventListener("change", () => {
        if (this.#page) {
          const pageSize = Number(this.#pageSizeSelect.value);
          this.#requestPage({
            ...this.#page,
            pageSize,
            pageIndex: Math.floor((this.#page.pageIndex * this.#page.pageSize) / pageSize),
          });
          this.#pageSizeSelect.value = String(this.#page.pageSize);
          return;
        }
        this.#table?.setPageSize(Number(this.#pageSizeSelect.value));
        this.#render();
      });
      this.#previousButton.addEventListener("click", () => {
        if (this.#page) {
          this.#requestPage({ ...this.#page, pageIndex: this.#page.pageIndex - 1 });
          return;
        }
        this.#table?.previousPage();
        this.#render();
      });
      this.#nextButton.addEventListener("click", () => {
        if (this.#page) {
          this.#requestPage({ ...this.#page, pageIndex: this.#page.pageIndex + 1 });
          return;
        }
        this.#table?.nextPage();
        this.#render();
      });
    }

    const assignedData = Object.prototype.hasOwnProperty.call(this, "data") ? this.data : undefined;
    const assignedColumns = Object.prototype.hasOwnProperty.call(this, "columns")
      ? this.columns
      : undefined;
    const ownPage = Object.prototype.hasOwnProperty.call(this, "page");
    const assignedPage = ownPage ? this.page : undefined;
    if (ownPage) Reflect.deleteProperty(this, "page");
    if (assignedData !== undefined) {
      Reflect.deleteProperty(this, "data");
      this.data = assignedData;
    }
    if (assignedColumns !== undefined) {
      Reflect.deleteProperty(this, "columns");
      this.columns = assignedColumns;
    }
    if (ownPage) this.page = assignedPage;
    this.#updateTable();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected || !this.shadowRoot) return;
    if (name === "page-size") {
      try {
        if (this.#table) {
          if (this.#page) {
            const pageSize = this.#pageSize();
            this.#requestPage({ ...this.#page, pageSize, pageIndex: 0 });
            return;
          }
          this.#table.setPageSize(this.#pageSize());
          this.#render();
        } else {
          this.#updateTable();
        }
      } catch (error) {
        this.#showError(error);
      }
      return;
    }
    this.#render();
  }

  #pageSize(): number {
    const attribute = this.getAttribute("page-size");
    const pageSize = attribute === null ? 10 : Number(attribute);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new RangeError("Table page-size must be a positive integer.");
    }
    return pageSize;
  }

  #updateTable(): void {
    if (!this.isConnected || !this.shadowRoot) return;
    try {
      if (this.#table) {
        this.#table.setOptions((options) => ({
          ...options,
          columns: this.#columns,
          data: this.#data,
          manualPagination: !!this.#page,
          manualSorting: !!this.#page,
          rowCount: this.#page?.rowCount,
        }));
        if (this.#page) {
          this.#table.setPagination({
            pageIndex: this.#page.pageIndex,
            pageSize: this.#page.pageSize,
          });
          this.#table.setSorting([...this.#page.sorting]);
        } else this.#table.setPageIndex(0);
      } else {
        this.#table = constructTable({
          features,
          columns: this.#columns,
          data: this.#data,
          manualPagination: !!this.#page,
          manualSorting: !!this.#page,
          rowCount: this.#page?.rowCount,
          initialState: {
            pagination: {
              pageIndex: this.#page?.pageIndex ?? 0,
              pageSize: this.#page?.pageSize ?? this.#pageSize(),
            },
            sorting: this.#page ? [...this.#page.sorting] : [],
          },
        });
      }
      this.#columnWidths = this.#measureColumnWidths();
      this.#render();
    } catch (error) {
      this.#showError(error);
    }
  }

  #render(): void {
    if (!this.#table || !this.shadowRoot) return;
    try {
      const table = this.#table;
      const label = this.getAttribute("aria-label");
      if (label === null) this.#tableElement.removeAttribute("aria-label");
      else this.#tableElement.setAttribute("aria-label", label);

      this.#columnGroup.replaceChildren(
        ...table.getAllLeafColumns().map((column) => {
          const element = document.createElement("col");
          element.style.width = `${this.#columnWidths.get(column.id) ?? 0}px`;
          return element;
        }),
      );

      const headerRows = table.getHeaderGroups().map((group) => {
        const row = document.createElement("tr");
        for (const header of group.headers) {
          const cell = document.createElement("th");
          cell.scope = "col";
          cell.colSpan = header.colSpan;
          const column = header.column;
          const direction = column.getIsSorted();
          if (direction)
            cell.setAttribute("aria-sort", direction === "asc" ? "ascending" : "descending");
          if (!header.isPlaceholder && column.getCanSort()) {
            const button = document.createElement("button");
            button.type = "button";
            button.disabled = this.hasAttribute("loading");
            const rendered = flexRender(column.columnDef.header, header.getContext());
            this.#appendRendered(button, rendered);
            const indicator = document.createElement("span");
            indicator.className = "sort-indicator";
            indicator.dataset.direction = direction || "none";
            indicator.setAttribute("aria-hidden", "true");
            button.append(indicator);
            button.addEventListener("click", () => {
              if (this.#page) {
                const next = column.getNextSortingOrder();
                this.#requestPage({
                  ...this.#page,
                  pageIndex: 0,
                  sorting: next ? [{ id: column.id, desc: next === "desc" }] : [],
                });
                return;
              }
              column.toggleSorting();
              this.#render();
            });
            cell.append(button);
          } else if (!header.isPlaceholder) {
            this.#appendRendered(cell, flexRender(column.columnDef.header, header.getContext()));
          }
          row.append(cell);
        }
        return row;
      });
      this.#head.replaceChildren(...headerRows);

      const rows = table.getRowModel().rows;
      const bodyRows = rows.map((row) => {
        const tr = document.createElement("tr");
        for (const cell of row.getAllCells()) {
          const td = document.createElement("td");
          const value = cell.column.columnDef.cell
            ? flexRender(cell.column.columnDef.cell, cell.getContext())
            : cell.renderValue();
          this.#appendRendered(td, value);
          tr.append(td);
        }
        return tr;
      });
      if (bodyRows.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.className = "empty";
        cell.colSpan = Math.max(1, table.getAllLeafColumns().length);
        cell.textContent = "No rows to display.";
        row.append(cell);
        bodyRows.push(row);
      }
      this.#body.replaceChildren(...bodyRows);

      const pagination = table.atoms.pagination.get();
      const pageCount = table.getPageCount();
      const rowCount = table.getRowCount();
      const firstRow = rowCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
      const lastRow = Math.min((pagination.pageIndex + 1) * pagination.pageSize, rowCount);
      const range = document.createElement("span");
      range.className = "range";
      range.textContent = `${firstRow}–${lastRow}`;
      const rangeDigits = Math.max(1, String(rowCount).length);
      range.style.minWidth = `${rangeDigits * 2 + 1}ch`;
      const pageRange = document.createElement("span");
      pageRange.className = "page-range";
      pageRange.textContent = `${pagination.pageIndex + 1} of ${pageCount}`;
      const pageDigits = rangeDigits;
      pageRange.style.minWidth = `${pageDigits * 2 + 4}ch`;
      this.#status.replaceChildren(
        document.createTextNode("Showing "),
        range,
        document.createTextNode(` of ${rowCount} rows · Page `),
        pageRange,
      );
      for (const option of this.#pageSizeSelect.querySelectorAll("option[data-custom]"))
        option.remove();
      this.#pageSizeSelect.value = String(pagination.pageSize);
      if (this.#pageSizeSelect.value !== String(pagination.pageSize)) {
        const customOption = document.createElement("option");
        customOption.value = String(pagination.pageSize);
        customOption.textContent = String(pagination.pageSize);
        customOption.dataset.custom = "";
        this.#pageSizeSelect.append(customOption);
        this.#pageSizeSelect.value = String(pagination.pageSize);
      }
      const loading = this.hasAttribute("loading");
      this.#tableElement.setAttribute("aria-busy", String(loading));
      this.#pageSizeSelect.disabled = loading;
      this.#previousButton.disabled = loading || !table.getCanPreviousPage();
      this.#nextButton.disabled = loading || !table.getCanNextPage();
      this.#container.hidden = false;
      this.#pagination.hidden = false;
      this.#error.hidden = true;
      this.#error.textContent = "";
    } catch (error) {
      this.#showError(error);
    }
  }

  #appendRendered(target: HTMLElement, value: unknown): void {
    if (value instanceof Node) {
      target.append(value);
    } else {
      target.textContent = this.#renderedText(value);
    }
  }

  #requestPage(request: MsTablePageRequest): void {
    if (this.hasAttribute("loading")) return;
    this.dispatchEvent(
      new CustomEvent<MsTablePageRequest>("ms-page-request", {
        detail: {
          pageIndex: request.pageIndex,
          pageSize: request.pageSize,
          sorting: request.sorting,
        },
        bubbles: true,
      }),
    );
  }

  #renderedText(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Node) return value.textContent ?? "";
    return String(value);
  }

  #columnWidths = new Map<string, number>();

  #measureColumnWidths(): Map<string, number> {
    const table = this.#table;
    if (!table) return new Map();
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("Unable to size table columns without a Canvas 2D context.");
    context.font = getComputedStyle(this.#tableElement).font;

    const widths = new Map<string, number>();
    for (const column of table.getAllLeafColumns()) {
      const header = table
        .getHeaderGroups()
        .flatMap((group) => group.headers)
        .find((item) => item.column.id === column.id && !item.isPlaceholder);
      const headerText = header
        ? this.#renderedText(flexRender(column.columnDef.header, header.getContext()))
        : column.id;
      widths.set(column.id, context.measureText(headerText).width);
    }

    for (const row of table.getCoreRowModel().rows) {
      for (const cell of row.getAllCells()) {
        const width = widths.get(cell.column.id);
        if (width === undefined) continue;
        const value = cell.column.columnDef.cell
          ? flexRender(cell.column.columnDef.cell, cell.getContext())
          : cell.renderValue();
        widths.set(
          cell.column.id,
          Math.max(width, context.measureText(this.#renderedText(value)).width),
        );
      }
    }

    return new Map([...widths].map(([id, width]) => [id, Math.ceil(width + 32)]));
  }

  #showError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.#container.hidden = true;
    this.#pagination.hidden = true;
    this.#error.textContent = err.message;
    this.#error.hidden = false;
    this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
  }
}

if (!customElements.get("ms-table")) {
  customElements.define("ms-table", MsTable);
}

declare global {
  interface HTMLElementTagNameMap {
    "ms-table": MsTable;
  }
}
