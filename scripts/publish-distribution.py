"""Publish immutable source releases after public CI and runtime verification.

Builds, image writes and release publication run on GitHub runners. A release tag
points to the exact public source commit verified by CI, never to a separate build.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time

from runtime_image import IMAGE, check_image_release, distribution_fingerprint

PUBLIC_REPO = "IlCandeDEV/dyntick"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
PRIVATE_CONTENT = re.compile(
    r"/Users/|/home/runner/work/|"
    r"github\.com/[^/\s]+/[^/\s\"']*-source(?:[\s\"'/#?.]|$)|"
    r"[\w.+-]+@(?:gmail\.com|icloud\.com|outlook\.com|protonmail\.com)|"
    r"BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|"
    r"github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}", re.I,
)


def release_caption(version, changelog):
    if not VERSION.fullmatch(version):
        raise ValueError("Expected a stable numeric version")
    headings = list(re.finditer(rf"^#{{1,6}}[ \t]+Dyntick[ \t]+{re.escape(version)}[ \t]*$", changelog, re.M))
    if len(headings) != 1:
        raise ValueError("Expected one changelog section for this release version")
    section = changelog[headings[0].end():]
    following = re.search(r"^#{1,6}[ \t]+", section, re.M)
    if following:
        section = section[:following.start()]
    return public_release_caption(version, section)


def public_release_caption(version, notes):
    if not VERSION.fullmatch(version):
        raise ValueError("Expected a stable numeric version")
    bullets = [line.strip() for line in notes.splitlines() if line.strip()]
    if not bullets or any(not line.startswith("- ") or not line[2:].strip() for line in bullets):
        raise ValueError("The release changelog must contain nonempty bullet points")
    caption = (f"Welcome to Dyntick v. {version}  \n"
               "A simple yet functional space to study.\n\n"
               "This version includes:\n\n" + "\n".join(bullets) + "\n")
    if PRIVATE_CONTENT.search(caption):
        raise ValueError("Private metadata in release notes")
    return caption


def audited_files(stage):
    if {p.name for p in stage.iterdir()} != {"Dockerfile", "README.md", "compose.yaml", "server.js", "site"}:
        raise ValueError("Unexpected runtime distribution files")
    if (stage / "README.md").read_bytes() or not (stage / "site/index.html").is_file() or not (stage / "server.js").is_file():
        raise ValueError("Expected an empty build-context README and a compiled site")
    files = {}
    for path in sorted(stage.rglob("*")):
        relative = path.relative_to(stage)
        if path.is_symlink() or any(part.startswith(".") for part in relative.parts):
            raise ValueError("Hidden files and symlinks are not runtime assets")
        if not path.is_file():
            continue
        if relative.parts[0] == "site" and path.suffix not in {".html", ".js", ".css", ".svg", ".woff2", ".txt"}:
            raise ValueError(f"Unsupported runtime asset: {relative}")
        content = path.read_bytes()
        if path.suffix != ".woff2" and PRIVATE_CONTENT.search(content.decode()):
            raise ValueError(f"Private metadata in {relative}")
        files[str(relative)] = content
    compose = files["compose.yaml"].decode()
    placeholder = "$" + "{DYNTICK_VERSION:-latest}"
    if (compose.count(placeholder) != 1 or f"image: {IMAGE}:{placeholder}" not in compose or
            re.search(r"^\s*build:", compose, re.M) or "pull_policy: always" not in compose or
            "dyntick-data:/data" not in compose):
        raise ValueError("Compose must pull the prebuilt latest image with a persistent SQLite volume")
    return files


def api(path, method="GET", body=None, missing=False):
    command = ["gh", "api", path, "--method", method]
    if body is not None:
        command += ["--input", "-"]
    result = subprocess.run(command, input=json.dumps(body) if body is not None else None, text=True, capture_output=True)
    if result.returncode:
        if missing and "HTTP 404" in result.stderr:
            return None
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout) if result.stdout.strip() else {}


def tag(name, sha):
    existing = api(f"repos/{PUBLIC_REPO}/git/ref/tags/{name}", missing=True)
    if existing is None:
        api(f"repos/{PUBLIC_REPO}/git/refs", "POST", {"ref": f"refs/tags/{name}", "sha": sha})
    elif existing["object"]["type"] != "commit" or existing["object"]["sha"] != sha:
        if name != "latest":
            raise ValueError(f"Numbered tag {name} is immutable")
        api(f"repos/{PUBLIC_REPO}/git/refs/tags/latest", "PATCH", {"sha": sha, "force": True})


def promote_image(version, ci_run, image_run, source_sha):
    api(f"repos/{PUBLIC_REPO}/actions/workflows/image.yml/dispatches", "POST", {
        "ref": "main", "inputs": {"operation": "latest", "version": version,
        "ci_run": str(ci_run), "image_run": str(image_run)}})
    promotion = None
    for _ in range(120):
        runs = api(f"repos/{PUBLIC_REPO}/actions/workflows/image.yml/runs?event=workflow_dispatch&head_sha={source_sha}&per_page=30")["workflow_runs"]
        matching = [run for run in runs if run["display_title"] == f"Runtime {version} latest" and run["id"] > image_run]
        if matching:
            promotion = max(matching, key=lambda run: run["id"])
            if promotion["status"] == "completed":
                break
        time.sleep(5)
    if not promotion or promotion["status"] != "completed" or promotion["conclusion"] != "success":
        raise ValueError("Runtime latest promotion did not pass; resume this verified release")
    return promotion["id"]


def verify_release_assets(release, expected):
    assets = {asset["name"]: asset for asset in release["assets"]}
    if set(expected) != {"compose.yaml"} or set(assets) != {"compose.yaml"} or len(release["assets"]) != 1:
        raise ValueError("Release attachments must contain only compose.yaml")
    for name, content in expected.items():
        if name not in assets:
            raise ValueError(f"Missing immutable release asset: {name}")
        result = subprocess.run(["gh", "api", "-H", "Accept: application/octet-stream",
            f"repos/{PUBLIC_REPO}/releases/assets/{assets[name]['id']}"], capture_output=True, check=True)
        if result.stdout != content:
            raise ValueError(f"Immutable release asset differs: {name}")


def verify_public_installation(version, source_sha, after_run):
    api(f"repos/{PUBLIC_REPO}/actions/workflows/distribution.yml/dispatches", "POST", {
        "ref": "main", "inputs": {"version": version}})
    verification = None
    for _ in range(120):
        runs = api(f"repos/{PUBLIC_REPO}/actions/workflows/distribution.yml/runs?event=workflow_dispatch&head_sha={source_sha}&per_page=30")["workflow_runs"]
        matches = [run for run in runs if run["display_title"] == f"Verify installation {version}" and run["id"] > after_run]
        if matches:
            verification = max(matches, key=lambda run: run["id"])
            if verification["status"] == "completed":
                break
        time.sleep(5)
    if not verification or verification["status"] != "completed" or verification["conclusion"] != "success":
        raise ValueError("Public Compose verification did not pass; inspect its GitHub run before delivery")
    return verification["id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("--version", required=True)
    parser.add_argument("--ci-run", type=int, required=True)
    parser.add_argument("--image-run", type=int)
    parser.add_argument("--publish", action="store_true")
    notes = parser.add_mutually_exclusive_group()
    notes.add_argument("--release-notes", help="Approved public release bullets, one per line")
    notes.add_argument("--changelog", type=Path, help="Preview the selected version from a local changelog")
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error("Expected a stable numeric version")
    if args.publish and args.release_notes is None:
        parser.error("Publication requires approved text via --release-notes")
    caption = None
    if args.release_notes is not None:
        caption = public_release_caption(args.version, args.release_notes)
    elif args.changelog is not None:
        caption = release_caption(args.version, args.changelog.read_text(encoding="utf-8"))
    stage = Path(args.directory).resolve()
    files = audited_files(stage)
    fingerprint = distribution_fingerprint(files)
    audit = {"repository": PUBLIC_REPO, "version": args.version, "files": len(files), "fingerprint": fingerprint}
    if caption is not None:
        audit["release_notes"] = caption
    print(json.dumps(audit), flush=True)
    if not args.publish:
        return
    repository = api("repositories/1455362824")
    if repository["full_name"] != PUBLIC_REPO or repository["private"] or repository["fork"]:
        raise ValueError("Expected the official public source repository")
    run = api(f"repos/{PUBLIC_REPO}/actions/runs/{args.ci_run}")
    if (run["status"] != "completed" or run["conclusion"] != "success" or
            run["repository"]["full_name"] != PUBLIC_REPO or
            run["path"] not in {".github/workflows/ci.yml", ".github/workflows/release.yml"}):
        raise ValueError("A successful public production verification is required")
    if not args.image_run:
        raise ValueError("A successful --image-run is required")
    source_sha = run["head_sha"]
    if api(f"repos/{PUBLIC_REPO}/git/ref/heads/main")["object"]["sha"] != source_sha:
        raise ValueError("Release the production-verified source main revision")
    proof = check_image_release(args.version, args.ci_run, args.image_run, fingerprint)
    release_path = f"repos/{PUBLIC_REPO}/releases/tags/{args.version}"
    existing = api(release_path, missing=True)
    latest = api(f"repos/{PUBLIC_REPO}/releases/latest")
    if not existing and tuple(map(int, args.version.split("."))) <= tuple(map(int, latest["tag_name"].removeprefix("v").split("."))):
        raise ValueError("A new stable release must be newer than the current latest")
    tag(args.version, source_sha)
    assets_path = stage.parent / ("release-" + args.version)
    assets_path.mkdir(parents=True, exist_ok=True)
    compose_path = assets_path / "compose.yaml"
    subprocess.run([sys.executable, str(Path(__file__).with_name("release-compose.py")),
                    args.version, str(compose_path), "--source", str(stage / "compose.yaml")], check=True)
    # The audit record belongs to Actions artifacts, outside the release attachments.
    proof_path = stage.parent / "runtime-image.json"
    proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
    notes_path = assets_path / "notes.md"
    notes_path.write_text(caption)
    if not existing:
        subprocess.run(["gh", "release", "create", args.version, str(compose_path),
                        "--repo", PUBLIC_REPO, "--verify-tag", "--title", "Dyntick v. " + args.version,
                        "--notes-file", str(notes_path)], check=True)
    release = api(release_path)
    if release["draft"] or release["prerelease"] or release["body"] != caption:
        raise ValueError("Published release description differs from the verified changelog")
    verify_release_assets(release, {"compose.yaml": compose_path.read_bytes()})
    promotion_run = promote_image(args.version, args.ci_run, args.image_run, source_sha)
    check_image_release(args.version, args.ci_run, args.image_run, fingerprint, latest=True)
    tag("latest", source_sha)
    verification_run = verify_public_installation(args.version, source_sha, promotion_run)
    state = {"version": args.version, "source_commit": source_sha, "commit": source_sha,
             "ci_run": args.ci_run, "image_run": args.image_run, "image_promotion_run": promotion_run,
             "verification_run": verification_run,
             "image": IMAGE, "image_digest": proof["digest"], "fingerprint": fingerprint,
             "release_url": release["html_url"], "verified": True}
    (stage.parent / ("publication-" + args.version + "-release.json")).write_text(json.dumps(state, indent=2) + "\n")
    print(json.dumps(state), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
