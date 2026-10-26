import type { ReactNode } from "react";
import type { spectrumReaders } from "@/lib/spectrum";

type SpectrumReaderId = (typeof spectrumReaders)[number]["id"];

const descriptions = {
  txt: (
    <>
      <p>
        Unquoted text (.txt, .asc, .csv, .tsv) with whitespace, tab, comma, semicolon, or pipe
        separators.
      </p>
      <p>Recognized headers:</p>
      <ul>
        <li>
          <strong>m/z:</strong> m/z or mz.
        </li>
        <li>
          <strong>Intensity:</strong> Intensity, I, or Abundance.
        </li>
        <li>
          <strong>S/N:</strong> S/N, SN, or SNR.
        </li>
        <li>
          <strong>RT:</strong> RT, RetentionTime, Retention time, or retention_time.
        </li>
      </ul>
      <p>
        Matching is case-insensitive and ignores spaces and punctuation within each column name.
      </p>
      <p>
        Headerless data uses the first two columns for m/z and intensity; S/N and RT require
        recognized headers or explicit column mappings. RT retains the input file&apos;s units.
      </p>
      <p>
        Blank lines and # comments are ignored. m/z must be positive; intensity, S/N, and RT must be
        nonnegative. All mapped values must be finite.
      </p>
    </>
  ),
} satisfies Record<SpectrumReaderId, ReactNode>;

export function SpectrumReaderDescription({ readerId }: { readerId: SpectrumReaderId }) {
  return descriptions[readerId];
}
