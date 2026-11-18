"""Produce the single-file Compose download for a specific immutable release."""
import argparse
from pathlib import Path
import re


def render_compose(source: str, version: str) -> str:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Expected a release version such as 1.1.0")
    output, count = re.subn(
        r"\$\{DYNTICK_VERSION:-(?:latest|[0-9]+\.[0-9]+\.[0-9]+)\}",
        lambda _: "${DYNTICK_VERSION:-" + version + "}",
        source,
    )
    if count != 1 or "image: ghcr.io/ilcandedev/dyntick-runtime:" not in source or re.search(r"^\s*build:", source, re.M):
        raise ValueError("Expected one prebuilt runtime image and no server-side build")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("output", nargs="?", default="release/compose.yaml")
    parser.add_argument("--source", default=str(Path(__file__).resolve().parent.parent / "compose.yaml"))
    args = parser.parse_args()
    try:
        output = render_compose(Path(args.source).read_text(), args.version)
    except ValueError as error:
        parser.error(str(error))
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(output)
    print(f"Prepared {target} for Dyntick {args.version}")
