"""Stage only precompiled runtime files for a separate, history-free public repository."""
import argparse
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("--version", default="1.5.0")
parser.add_argument("--site", default="dist")
parser.add_argument("--output", default=".ci-output/distribution")
args = parser.parse_args()
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
    raise SystemExit("Expected a semantic version such as 1.2.0")

root = Path(__file__).resolve().parent.parent
site = (root / args.site).resolve()
output = (root / args.output).resolve()
if not (site / "index.html").is_file():
    raise SystemExit("Build the static application before preparing a distribution")
if output == root or output == site or output in site.parents:
    raise SystemExit("The distribution needs its own empty staging directory")

allowed_extensions = {".html", ".js", ".css", ".woff2", ".svg", ".txt"}
text_extensions = allowed_extensions - {".woff2"}
runtime_files = sorted(path for path in site.rglob("*") if path.is_file())
for path in runtime_files:
    relative = path.relative_to(site)
    if path.is_symlink() or path.suffix not in allowed_extensions or any(part.startswith(".") for part in relative.parts):
        raise SystemExit(f"Unsupported public runtime asset: {relative}")

output.mkdir(parents=True, exist_ok=False)
shutil.copytree(site, output / "site")
shutil.copyfile(root / "LICENSE", output / "site/LICENSE.txt")
shutil.copyfile(root / "deploy/distribution.Dockerfile", output / "Dockerfile")
shutil.copyfile(root / "deploy/nginx.conf", output / "nginx.conf")
(output / "README.md").write_bytes(b"")
# Public main serves the rolling Compose; release attachments are pinned separately.
shutil.copyfile(root / "compose.yaml", output / "compose.yaml")

# Only this allowlist is eligible for publication. Never copy Git or project documents.
allowed_top_level = {"site", "Dockerfile", "nginx.conf", "compose.yaml", "README.md"}
if {path.name for path in output.iterdir()} != allowed_top_level:
    raise SystemExit("Unexpected file in the public distribution")
if (output / "README.md").stat().st_size != 0:
    raise SystemExit("The public README must be empty")

# These checks run in private CI and publish neither logs nor source metadata.
private_repo = re.compile(r"(?:https?://|git@)github\.com[:/][^/\s]+/[^/\s\"']*-source(?=$|[\s\"'/#?.])")
for path in sorted(output.rglob("*")):
    if not path.is_file() or path.suffix not in text_extensions | {""}:
        continue
    content = path.read_text()
    if private_repo.search(content) or re.search(r"/Users/|/home/runner/work/|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY", content):
        raise SystemExit(f"Private path or metadata found in {path.relative_to(output)}")

print(f"Prepared {len(runtime_files)} compiled web assets, the application license and four runtime files.")
