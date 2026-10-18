#!/usr/bin/env python3
"""Compose a dsh profile's patch stack from disk + the RUNNING build, and report its preset roster.

Why this exists: a profile's preset rows (the list the New Session screen offers) are not a file
you can read -- they are the `@deepseek-ai/dsh-agent-preset` entries of the patch stack, composed
as: each bundle in `dsh.profile.bundles` order (its `dsh.bundle.patch` files), then the profile's
own `cordis.patch.yml`, then the home layer (`$DSH_HOME/cordis.patch.yml`). The app reads that at
STARTUP, so after editing the manifest the roster cannot be observed from the running GUI without
a restart. This tool answers the same question from the files, against the running build.

It also checks the failure that editing the manifest invites: `agent-preset-registry.selectedDefault`
is "the default preset for a subsequently created session" (`defaultId = selectedDefault ?? default`),
so removing a preset without moving that id leaves every new session pointed at a preset that no
longer exists.

Read-only. Exit 0 = roster is coherent; 1 = a dangling selection or an unresolved bundle.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import yaml

DEFAULT_PROFILE = Path.home() / ".dsh" / "profiles" / "desktop"
DEFAULT_ASAR = Path(
    r"C:\Users\14339\AppData\Local\Programs\DeepSeek Harness\resources\app.asar"
)
PRESET_PLUGIN = "@deepseek-ai/dsh-agent-preset"
REGISTRY_ID = "agent-preset-registry"


class PatchLoader(yaml.SafeLoader):
    """SafeLoader that tolerates `!!js <expr>` -- patch layers are allowed to carry it.

    The value is only ever inspected for preset/registry rows, so keeping the expression as an
    opaque string (rather than evaluating it) is both enough and the honest thing to do.
    """


def _opaque_js(loader: yaml.SafeLoader, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        return f"!!js {loader.construct_scalar(node)}"
    return None


PatchLoader.add_constructor("tag:yaml.org,2002:js", _opaque_js)


def load_patch(text: str):
    return yaml.load(text, Loader=PatchLoader) or []


def load_asar_module():
    path = Path(__file__).with_name("asar-read.py")
    spec = importlib.util.spec_from_file_location("asar_read", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Source:
    """Resolve a bundle directory and read its patch files, from disk or from the asar."""

    def __init__(self, asar_path: Path, profile: Path) -> None:
        mod = load_asar_module()
        self.asar = mod.Asar(asar_path)
        self.asar_path = asar_path
        self.profile = profile
        self.entries = {path: entry for path, entry in self.asar.walk()}

    def bundle_dir(self, name: str):
        """`(directory, in_asar)`. On disk `directory` is a Path; inside the asar it stays a POSIX
        string -- `Path('/dsh/x')` on Windows is a drive-relative path and `str()` rewrites the
        separators, producing a key the asar index does not have."""
        local = self.profile / "node_modules" / name
        if local.exists():
            return local, False
        inside = f"/dsh/node_modules/{name}"
        if any(p.startswith(inside + "/") for p in self.entries):
            return inside, True
        raise LookupError(name)

    def read_text(self, directory, in_asar: bool, relative: str) -> str:
        if not in_asar:
            return (directory / relative).read_text(encoding="utf-8")
        joined = directory.rstrip("/") + "/" + relative.lstrip("./")
        entry = self.entries.get(joined)
        if entry is None:
            raise LookupError(joined)
        return self.asar.read(entry, joined).decode("utf-8", "replace")

    def package_manifest(self, name: str) -> dict:
        directory, in_asar = self.bundle_dir(name)
        return json.loads(self.read_text(directory, in_asar, "package.json"))


def patch_files(manifest: dict) -> list[str]:
    patch = (manifest.get("dsh") or {}).get("bundle", {}).get("patch")
    if patch is None:
        return []
    return [patch] if isinstance(patch, str) else list(patch)


def compose(source: Source) -> tuple[list, list[str], list[str]]:
    """Return (entries, layers, problems) for the profile's effective patch stack."""
    manifest = json.loads((source.profile / "package.json").read_text(encoding="utf-8"))
    bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles", [])
    entries: list = []
    layers: list[str] = []
    problems: list[str] = []

    for name in bundles:
        try:
            directory, in_asar = source.bundle_dir(name)
            bundle_manifest = source.package_manifest(name)
        except (LookupError, FileNotFoundError):
            problems.append(f"bundle not resolvable: {name}")
            continue
        for relative in patch_files(bundle_manifest):
            try:
                entries.extend(load_patch(source.read_text(directory, in_asar, relative)) or [])
            except (LookupError, FileNotFoundError):
                problems.append(f"patch file missing: {name}{relative}")
                continue
            layers.append(f"{name}{relative}")

    for extra in (source.profile / "cordis.patch.yml", Path.home() / ".dsh" / "cordis.patch.yml"):
        if extra.exists():
            entries.extend(load_patch(extra.read_text(encoding="utf-8")) or [])
            layers.append(str(extra))

    # A bundle listed in the manifest but absent from `bundles` cannot contribute a row; the
    # manifest's own dependencies are how the app decides (reconcileProfilePlugins).
    for name in (manifest.get("dependencies") or {}):
        if name not in bundles and not name.startswith("@deepseek-ai/dsh-"):
            problems.append(f"installed but NOT an active bundle: {name}")

    return entries, layers, problems


def flatten(entries) -> list:
    """Patch layers may nest: a top-level entry carries an `insert:` list of the rows it adds, and
    the preset rows live in there (`- insert: [- id: preset-…, name: '@deepseek-ai/dsh-agent-preset']`)."""
    flat: list = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        flat.append(entry)
        nested = entry.get("insert")
        if isinstance(nested, list):
            flat.extend(flatten(nested))
    return flat


def roster(entries: list) -> list[tuple[str, str, str]]:
    rows = []
    for entry in flatten(entries):
        if entry.get("name") != PRESET_PLUGIN:
            continue
        config = entry.get("config") or {}
        rows.append((str(config.get("id")), str(config.get("name")), str(entry.get("id"))))
    return rows


def registry_config(entries: list) -> dict:
    config: dict = {}
    for entry in flatten(entries):
        if entry.get("id") == REGISTRY_ID:
            config.update(entry.get("config") or {})
    return config


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--asar", type=Path, default=DEFAULT_ASAR)
    parser.add_argument("--quiet-layers", action="store_true")
    args = parser.parse_args()

    source = Source(args.asar, args.profile)
    entries, layers, problems = compose(source)

    print(f"profile : {args.profile}")
    print(f"build   : {args.asar}")
    if not args.quiet_layers:
        print("layers  :")
        for layer in layers:
            print(f"  - {layer}")

    rows = roster(entries)
    print(f"\nroster ({len(rows)} rows):")
    for preset_id, name, entry_id in rows:
        print(f"  {preset_id:<16} {name}   [entry {entry_id}]")

    config = registry_config(entries)
    default = config.get("default")
    selected = config.get("selectedDefault")
    effective = selected if selected not in (None, "undefined") else default
    print(f"\nagent-preset-registry: default={default!r} selectedDefault={selected!r}")
    print(f"effective default for a new session: {effective!r}")

    ids = {preset_id for preset_id, _, _ in rows}
    if not ids:
        problems.append("no preset rows found -- the composition looks wrong")
    if effective not in ids:
        problems.append(
            f"effective default {effective!r} is not in the roster {sorted(ids)} -- "
            "a new session would point at a preset that does not exist"
        )

    print()
    for problem in problems:
        print(f"PROBLEM: {problem}")
    if problems:
        print(f"\nFAIL ({len(problems)} problem(s))")
        return 1
    print(f"OK: {len(ids)} presets, effective default {effective!r} resolves")
    return 0


if __name__ == "__main__":
    sys.exit(main())

