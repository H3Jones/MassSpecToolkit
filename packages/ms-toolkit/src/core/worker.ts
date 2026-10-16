import { expose } from "comlink";
import { api } from "./wasm.ts";

expose(api);
