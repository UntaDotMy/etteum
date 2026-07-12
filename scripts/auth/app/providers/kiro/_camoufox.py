from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def _camoufox_launch_relpaths() -> list[Path]:
    if sys.platform == "win32":
        return [Path("camoufox.exe")]
    if sys.platform == "darwin":
        return [
            Path("Camoufox.app") / "Contents" / "MacOS" / "camoufox",
            Path("camoufox.app") / "Contents" / "MacOS" / "camoufox",
        ]
    return [Path("camoufox-bin")]


def _camoufox_cache_candidates() -> list[Path]:
    candidates: list[Path] = []
    seen: set[str] = set()

    def add(path: Path) -> None:
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        candidates.append(path)

    roots: list[Path] = []
    local_appdata = os.getenv("LOCALAPPDATA")
    if local_appdata:
        roots.extend([
            Path(local_appdata) / "camoufox",
            Path(local_appdata) / "camoufox" / "camoufox",
        ])

    home = Path.home()
    roots.extend([
        home / ".camoufox",
        home / ".cache" / "camoufox",
        home / ".local" / "share" / "camoufox",
        home / "Library" / "Caches" / "camoufox",
        home / "Library" / "Application Support" / "camoufox",
    ])

    xdg_cache = os.getenv("XDG_CACHE_HOME")
    if xdg_cache:
        roots.append(Path(xdg_cache) / "camoufox")
    xdg_data = os.getenv("XDG_DATA_HOME")
    if xdg_data:
        roots.append(Path(xdg_data) / "camoufox")

    for root in roots:
        add(root)
        add(root / "Cache")

    return candidates


def _repair_camoufox_cache_version() -> None:
    """Repair Camoufox cache layouts where root metadata files are missing."""
    launch_relpaths = _camoufox_launch_relpaths()
    for cache_dir in _camoufox_cache_candidates():
        root_version = cache_dir / "version.json"
        root_properties = cache_dir / "properties.json"
        root_launches = [cache_dir / rel for rel in launch_relpaths]
        if root_version.exists():
            try:
                data = json.loads(root_version.read_text(encoding="utf-8"))
                release = data.get("release") or data.get("tag") or data.get("build")
                version = data.get("version")
                if release:
                    normalized = {"release": release}
                    if version:
                        normalized["version"] = version
                    if data != normalized:
                        root_version.write_text(
                            json.dumps(normalized),
                            encoding="utf-8",
                        )
            except Exception:
                pass
        if root_version.exists() and root_properties.exists() and any(
            path.exists() for path in root_launches
        ):
            return
        browsers_dir = cache_dir / "browsers"
        if not browsers_dir.exists():
            continue
        versions = sorted(
            browsers_dir.rglob("version.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not versions:
            continue
        try:
            latest_version = versions[0]
            nested_data = json.loads(latest_version.read_text(encoding="utf-8"))
            release = (
                nested_data.get("release")
                or nested_data.get("tag")
                or nested_data.get("build")
            )
            version = nested_data.get("version")
            if not release:
                continue
            normalized = {"release": release}
            if version:
                normalized["version"] = version
            cache_dir.mkdir(parents=True, exist_ok=True)
            root_version.write_text(json.dumps(normalized), encoding="utf-8")
            active_dir = latest_version.parent
            nested_properties = active_dir / "properties.json"
            if nested_properties.exists() and not root_properties.exists():
                root_properties.write_bytes(nested_properties.read_bytes())
            if not any(path.exists() for path in root_launches):
                for child in active_dir.iterdir():
                    target = cache_dir / child.name
                    if child.name == "version.json":
                        continue
                    if child.is_dir():
                        shutil.copytree(child, target, dirs_exist_ok=True)
                    else:
                        shutil.copy2(child, target)
            if root_version.exists() and root_properties.exists() and any(
                path.exists() for path in root_launches
            ):
                return
            return
        except Exception:
            continue


