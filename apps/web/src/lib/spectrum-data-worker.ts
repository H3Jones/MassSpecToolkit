import { expose } from "comlink";
import { createSpectrumDataWorker } from "./spectrum-data";

expose(createSpectrumDataWorker());
