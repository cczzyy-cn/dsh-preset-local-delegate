#!/usr/bin/env python3
"""Validate a generated preset bundle before it is installed.

Checks, in order:
  1. the patch parses as YAML (with `!!js` registered, since DSH's Loader uses that tag);
  2. the shape is an `insert` of a `@deepseek-ai/dsh-agent-preset` row carrying id/plugins;
  3. every `@deepseek-ai/...` package the plugin list names actually exists in this DSH build
     (read out of app.asar) - the migration note says a renamed package "fails at activation",
     and an activation failure leaves the preset unusable on the roster;
  4. every `./x.mjs` module the list references is present in the bundle directory.

Read-only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

DEFAULT_ASAR = Path(r"C:\Users\14339\AppData\Local\Programs\DeepSeek Harness\resources\app.asar")


class Loader(yaml.SafeLoader):
    pass


Loader.add_constructor("tag:yaml.org,2002:js", lambda l, n: l.construct_scalar(n))


def collect_names(node, out: set[str]) -> None:
    if isinstance(node, dict):
        n = node.get("name")
        if isinstance(n, str):
            out.add(n)
        for v in node.values():
            collect_names(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_names(v, out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle_dir")
    ap.add_argument("--asar", default=str(DEFAULT_ASAR))
    a = ap.parse_args()
    d = Path(a.bundle_dir)
    patch = d / "cordis.patch.yml"
    if not patch.exists():
        raise SystemExit(f"no cordis.patch.yml in {d}")

    print(f"bundle: {d}")
    doc = yaml.load(patch.read_text(encoding="utf-8"), Loader=Loader)
    if not isinstance(doc, list) or not doc:
        raise SystemExit("patch is not a non-empty top-level list")
    row = doc[0]
    if "insert" not in row:
        raise SystemExit("first entry has no `insert:`")
    decl = row["insert"][0]
    print(f"  loader row id : {decl.get('id')}")
    print(f"  plugin        : {decl.get('name')}")
    cfg = decl.get("config") or {}
    plugins = cfg.get("plugins")
    print(f"  preset id     : {cfg.get('id')}   (must be lowercase letters/digits/hyphens)")
    if not re.fullmatch(r"[a-z0-9-]+", str(cfg.get("id", ""))):
        raise SystemExit(f"  !! invalid preset id: {cfg.get('id')!r}")
    print(f"  display name  : {cfg.get('name')}")
    print(f"  order         : {cfg.get('order')}")
    print(f"  plugins       : {len(plugins) if isinstance(plugins, list) else 'NOT A LIST'}")

    names: set[str] = set()
    collect_names(plugins, names)

    pkgs = sorted(n for n in names if n.startswith("@deepseek-ai/"))
    local = sorted(n for n in names if n.startswith("./"))

    # A bundle may also reference its own modules as PACKAGE SUBPATHS (`<pkg>/x.mjs`, backed by
    # the bundle's `exports` map) instead of `./x.mjs`. That is the form that resolves
    # deterministically from anywhere, and it is the form a migrated preset ends up with — but a
    # `./`-only check silently skips it, and a missing one fails at ACTIVATION with
    # "Cannot find module", not here.
    own = json.loads((d / "package.json").read_text(encoding="utf-8")) \
        if (d / "package.json").exists() else {}
    pkg_name = str(own.get("name", ""))
    exports = own.get("exports") or {}
    subpaths = sorted(n for n in names if pkg_name and n.startswith(f"{pkg_name}/"))

    asar = Path(a.asar)
    builtin = set(re.findall(r"@deepseek-ai/[a-z0-9-]+(?:/[a-z0-9-]+)?",
                             asar.read_bytes().decode("utf-8", "replace")))
    print(f"\nreferenced @deepseek-ai packages: {len(pkgs)}")
    missing = []
    for p in pkgs:
        if p in builtin:
            print(f"  OK       {p}")
        else:
            print(f"  MISSING  {p}")
            missing.append(p)

    print(f"\nreferenced local modules: {len(local)}")
    miss_mod = []
    for m in local:
        fn = m[2:].split("?")[0]                       # strip ./ and any ?v= cache-buster
        ok = (d / fn).exists()
        print(f"  {'OK      ' if ok else 'MISSING '} {m}  ->  {fn}")
        if not ok:
            miss_mod.append(fn)

    print(f"\nreferenced own-package subpaths: {len(subpaths)}   (package {pkg_name or '?'})")
    for m in subpaths:
        sub = "./" + m[len(pkg_name) + 1:]
        fn = sub[2:].split("?")[0]
        listed = sub in exports
        present = (d / fn).exists()
        ok = listed and present
        why = "" if ok else (" (not in package.json `exports`)" if not listed else " (file missing)")
        print(f"  {'OK      ' if ok else 'MISSING '} {m}{why}")
        if not ok:
            miss_mod.append(fn)

    print()
    if missing or miss_mod:
        if missing:
            print(f"!! {len(missing)} package(s) absent from this DSH build -> activation will fail")
        if miss_mod:
            print(f"!! {len(miss_mod)} local module(s) missing from the bundle dir")
        return 1
    print("valid: patch parses, shape is correct, every package exists, every local module is present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
