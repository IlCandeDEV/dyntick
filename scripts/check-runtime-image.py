"""Compare the actual shipped image's files and metadata with its audited context."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile

image, container, architecture, stage_name = sys.argv[1:]
stage = Path(stage_name)
metadata = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
history = subprocess.check_output(["docker", "history", "--no-trunc", "--format", "{{json .}}", image], text=True)
audit = runpy.run_path(str(Path(__file__).with_name("publish-distribution.py")))
public_source = "https://github.com/IlCandeDEV/dyntick"
assert metadata["Architecture"] == architecture
assert metadata["Config"]["User"] == "1000"
assert metadata["Config"]["Labels"]["org.opencontainers.image.source"] == public_source
assert metadata["Config"]["Labels"]["org.opencontainers.image.revision"] == os.environ["GITHUB_SHA"]
assert metadata["Config"]["Labels"]["org.opencontainers.image.licenses"] == "PolyForm-Noncommercial-1.0.0"
text = json.dumps(metadata) + history
assert not audit["PRIVATE_CONTENT"].search(text), "Private runtime image metadata"

with tempfile.TemporaryDirectory() as directory:
    destination = Path(directory) / "site"
    subprocess.run(["docker", "cp", f"{container}:/app/site", str(destination)], check=True)
    expected = {str(p.relative_to(stage / "site")): p for p in (stage / "site").rglob("*") if p.is_file()}
    actual = {str(p.relative_to(destination)): p for p in destination.rglob("*") if p.is_file()}
    assert set(expected) == set(actual), "Unexpected public runtime files"
    for name, path in actual.items():
        assert not path.is_symlink()
        data = path.read_bytes()
        if name in expected:
            assert hashlib.sha256(data).digest() == hashlib.sha256(expected[name].read_bytes()).digest(), name
        if path.suffix != ".woff2":
            assert not audit["PRIVATE_CONTENT"].search(data.decode()), name
            assert os.environ["GITHUB_SHA"].encode() not in data, name
    subprocess.run(["docker", "cp", f"{container}:/app/server.js", str(Path(directory) / "server.js")], check=True)
    assert (Path(directory) / "server.js").read_bytes() == (stage / "server.js").read_bytes()
    assert not audit["PRIVATE_CONTENT"].search((Path(directory) / "server.js").read_text())
    assert os.environ["GITHUB_SHA"] not in (Path(directory) / "server.js").read_text()

print(f"Verified {architecture} image: UID 1000, public metadata and exact compiled web/API assets.")
