#!/usr/bin/env python3
"""Read files out of an Electron app.asar without unpacking the whole archive.

Why: several conclusions about this preset only hold if they hold in the RUNNING build, and the
running build is the 121 MB `app.asar` next to the executable -- not the sibling git checkout.
This reads the asar index (a JSON tree after a 16-byte header) and then seeks to individual file
payloads, so `--find`/`--grep` cost a few MB of I/O instead of 121 MB.

Usage:
  python tools/asar-read.py --find attachment                 # list matching paths
  python tools/asar-read.py --grep "SaveImageAttachment"      # show matches with context
  python tools/asar-read.py --cat <path-in-asar>              # print one file

Read-only.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

DEFAULT_ASAR = Path(
    r"C:\Users\14339\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
)


class Asar:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.f = open(path, "rb")
        head = self.f.read(16)
        if len(head) < 16:
            raise SystemExit(f"not an asar (too short): {path}")
        self.header_size = struct.unpack("<I", head[4:8])[0]
        json_len = struct.unpack("<I", head[12:16])[0]
        self.f.seek(16)
        self.tree = json.loads(self.f.read(json_len).decode("utf-8", "replace"))
        self.base = 8 + self.header_size

    def walk(self, node: dict | None = None, prefix: str = ""):
        node = self.tree if node is None else node
        for name, entry in node.get("files", {}).items():
            p = f"{prefix}/{name}"
            if "files" in entry:
                yield from self.walk(entry, p)
            else:
                yield p, entry

    def read(self, entry: dict, path: str = "") -> bytes:
        """Payload bytes for one entry. `unpacked: true` entries live beside the archive."""
        if "offset" not in entry:
            unpacked = self.path.parent / "app.asar.unpacked" / path.lstrip("/")
            return unpacked.read_bytes()
        self.f.seek(self.base + int(entry["offset"]))
        return self.f.read(int(entry["size"]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--asar", default=str(DEFAULT_ASAR))
    ap.add_argument("--find", help="regex over full paths; list matches")
    ap.add_argument("--grep", help="regex over file contents of .js/.mjs/.cjs/.ts files")
    ap.add_argument("--cat", help="exact path inside the asar to print")
    ap.add_argument("--limit", type=int, default=40, help="max files shown by --grep")
    ap.add_argument("--context", type=int, default=0, help="chars of context around a grep hit")
    ap.add_argument("--ext", default=r"\.(m?js|cjs|ts)$", help="extension regex for --grep")
    a = ap.parse_args()

    p = Path(a.asar)
    if not p.exists():
        raise SystemExit(f"not found: {p}")
    ar = Asar(p)

    if a.cat:
        want = a.cat.replace("\\", "/").lstrip("/")
        for path, entry in ar.walk():
            if path.lstrip("/") == want:
                sys.stdout.write(ar.read(entry, path).decode("utf-8", "replace"))
                return 0
        raise SystemExit(f"no such file in asar: {want}")

    if a.find:
        rx = re.compile(a.find, re.I)
        n = 0
        for path, entry in ar.walk():
            if rx.search(path):
                print(f"{entry['size']:>9}  {path}")
                n += 1
        print(f"-- {n} path(s) matched {a.find!r}")
        return 0

    if a.grep:
        rx = re.compile(a.grep)
        ext = re.compile(a.ext)
        n = 0
        for path, entry in ar.walk():
            if not ext.search(path):
                continue
            if int(entry["size"]) > 4_000_000:
                continue
            text = ar.read(entry, path).decode("utf-8", "replace")
            if not rx.search(text):
                continue
            n += 1
            print(f"=== {path} ({entry['size']} B) ===")
            for m in rx.finditer(text):
                s = max(0, m.start() - a.context)
                e = min(len(text), m.end() + a.context)
                snippet = text[s:e].replace("\n", "\n    ")
                print(f"  @{m.start()}: {snippet}")
            print()
            if n >= a.limit:
                print(f"-- stopped at --limit {a.limit}")
                break
        print(f"-- {n} file(s) matched {a.grep!r}")
        return 0

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
