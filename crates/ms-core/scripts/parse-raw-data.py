# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "toml",
# ]
# ///

import re
import toml
import os

def main() -> None:

    script_dir = os.path.dirname(os.path.abspath(__file__))

    # Read data from url
    url = "https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=&ascii=ascii2&isotype=all"
    from urllib import request
    # Create a request with a browser-like User-Agent
    req = request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    
    with request.urlopen(req) as response:
        raw_data = response.read().decode("utf-8")

    # get the data we need from the HTML
    raw_data = re.search(r"<pre>(.*?)</pre>", raw_data, re.DOTALL).group(1)
    # remove anything thing between <a> tags
    raw_data = re.sub(r"<a[^>]*>.*?</a>", "", raw_data, flags=re.DOTALL)
    # remove any remaining HTML tags

    # --- Parse blocks ---
    entries = []
    for block in raw_data.strip().split("\n\n"):
        entry = {}
        for line in block.splitlines():
            if "=" in line:
                key, value = [x.strip() for x in line.split("=", 1)]
                entry[key] = value if value else None
        if entry:
            entries.append(entry)

    # --- Convert entries to TOML structure ---
    isotopes = {}
    most_abundant = {}

    for entry in entries:
        if "Atomic Number" not in entry:
            print(f"Entry missing Atomic Number: {entry}")
            continue

        Z = int(entry["Atomic Number"])
        symbol = entry["Atomic Symbol"]
        A = int(entry["Mass Number"])
        neutrons = A - Z

        # strip parentheses from Relative Atomic Mass
        ram = entry["Relative Atomic Mass"]
        if ram:
            ram_val = float(re.sub(r"\([^)]*\)", "", ram))
        else:
            ram_val = None

        # convert isotopic composition to percentage
        ic = entry.get("Isotopic Composition")
        if ic:
            ic_val = float(re.sub(r"\([^)]*\)", "", ic)) * 100
        else:
            ic_val = None

        isotope_id = f"{A}{symbol}"

        isotopes[isotope_id] = {
            "id": isotope_id,
            "symbol": symbol,
            "atomic_number": Z,
            "neutron_number": neutrons,
            "relative_atomic_mass": ram_val,
        }
        if ic_val is not None:
            isotopes[isotope_id]["isotopic_abundance"] = ic_val

        # track most abundant isotope per element
        if ic_val is not None:
            if symbol not in most_abundant or ic_val > most_abundant[symbol][1]:
                most_abundant[symbol] = (isotope_id, ic_val)

    # --- Build TOML tree ---
    toml_data = {
        "common": {
            "most_abundant": {sym: iso for sym, (iso, _) in most_abundant.items()}
        },
        "isotopes": isotopes
    }

    # --- Write to TOML string/file ---
    toml_str = toml.dumps(toml_data)
    toml_path = os.path.join(script_dir, "..", "assets", "isotopes.toml")

    with open(toml_path, "w") as f:
        f.write(toml_str)

    print(f"Wrote {len(isotopes)} isotopes to {toml_path}")


if __name__ == "__main__":
    main()
