"""Bind runtime images to the audited artifacts of their public source CI.

Registry writes execute on GitHub runners. Anonymous reads prove that installation
needs no GitHub credentials. Proof links the image to its public source revision.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

IMAGE = "ghcr.io/ilcandedev/dyntick-runtime"
SOURCE_REPO = "IlCandeDEV/dyntick"
PUBLIC_REPO = "IlCandeDEV/dyntick"
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
ARCHITECTURES = ["linux/amd64", "linux/arm64"]
MANIFEST_ACCEPT = ", ".join(["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"])


def api(path):
    result = subprocess.run(["gh", "api", path], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def distribution_fingerprint(files):
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def successful_run(run_id, workflow):
    run = api(f"repos/{SOURCE_REPO}/actions/runs/{int(run_id)}")
    if (run["status"] != "completed" or run["conclusion"] != "success" or
            run["repository"]["full_name"] != SOURCE_REPO or run["path"] not in workflow):
        raise ValueError("Expected successful verification in the official source repository")
    return run


def artifact_bytes(run_id, name):
    artifacts = api(f"repos/{SOURCE_REPO}/actions/runs/{int(run_id)}/artifacts?per_page=100")["artifacts"]
    matching = [item for item in artifacts if item["name"] == name and not item["expired"]]
    if len(matching) != 1:
        raise ValueError(f"Expected one unexpired {name} artifact")
    artifact = matching[0]
    result = subprocess.run(["gh", "api", f"repos/{SOURCE_REPO}/actions/artifacts/{artifact['id']}/zip"], capture_output=True, check=True)
    if "sha256:" + hashlib.sha256(result.stdout).hexdigest() != artifact["digest"]:
        raise ValueError("CI artifact archive digest mismatch")
    return result.stdout, artifact


def unpack_artifact(data, output):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("Unsafe CI artifact archive")
        archive.extractall(output)


def manifest_architectures(manifest):
    platforms = [item.get("platform", {}) for item in manifest.get("manifests", [])]
    names = sorted(f"{item.get('os')}/{item.get('architecture')}" for item in platforms)
    if names != ARCHITECTURES:
        raise ValueError("Runtime index must contain exactly the amd64 and arm64 images")
    return names


def anonymous_manifest(reference):
    query = urlencode({"service": "ghcr.io", "scope": "repository:ilcandedev/dyntick-runtime:pull"})
    try:
        with urlopen("https://ghcr.io/token?" + query, timeout=30) as response:
            token = json.load(response)["token"]
        request = Request("https://ghcr.io/v2/ilcandedev/dyntick-runtime/manifests/" + reference,
                          headers={"Authorization": "Bearer " + token, "Accept": MANIFEST_ACCEPT})
        with urlopen(request, timeout=30) as response:
            raw = response.read()
            digest = "sha256:" + hashlib.sha256(raw).hexdigest()
            if response.headers.get("Docker-Content-Digest") != digest:
                raise ValueError("Registry manifest digest mismatch")
        manifest = json.loads(raw)
        manifest_architectures(manifest)
        return digest, manifest
    except HTTPError as error:
        raise ValueError(f"Runtime image must be publicly pullable without credentials (HTTP {error.code})") from error


def validate_proof(proof, version, ci_run, fingerprint, source_sha):
    if (not VERSION.fullmatch(version) or proof.get("image") != IMAGE or proof.get("version") != version or
            proof.get("ci_run") != int(ci_run) or proof.get("fingerprint") != fingerprint or
            proof.get("source_sha") != source_sha or proof.get("source_repository") != SOURCE_REPO or
            proof.get("source_url") != f"https://github.com/{SOURCE_REPO}/commit/{source_sha}" or
            proof.get("license") != "PolyForm-Noncommercial-1.0.0" or proof.get("architectures") != ARCHITECTURES or
            not DIGEST.fullmatch(proof.get("digest", ""))):
        raise ValueError("Runtime image proof does not match this verified distribution")


def check_image_release(version, ci_run, image_run, fingerprint=None, latest=False):
    production = successful_run(ci_run, {".github/workflows/ci.yml", ".github/workflows/release.yml"})
    image_job = successful_run(image_run, {".github/workflows/image.yml"})
    if image_job["head_sha"] != production["head_sha"] or image_job["display_title"] != f"Runtime {version} publish":
        raise ValueError("Runtime image and production CI must verify the same source revision")
    data, artifact = artifact_bytes(image_run, "runtime-image-proof")
    if artifact["workflow_run"]["head_sha"] != production["head_sha"]:
        raise ValueError("Runtime proof artifact revision mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if archive.namelist() != ["runtime-image-proof.json"]:
            raise ValueError("Unexpected runtime proof artifact contents")
        proof = json.loads(archive.read("runtime-image-proof.json"))
    validate_proof(proof, version, ci_run, fingerprint or proof.get("fingerprint"), production["head_sha"])
    digest, _ = anonymous_manifest("latest" if latest else version)
    if digest != proof["digest"]:
        raise ValueError("Public image differs from the verified runtime image")
    return proof


def authenticated_manifest(reference, missing=False):
    result = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", reference], capture_output=True, text=True)
    if result.returncode:
        if missing and ("not found" in result.stderr.lower() or "manifest_unknown" in result.stderr.lower()):
            return None
        raise RuntimeError(result.stderr.strip())
    manifest = json.loads(result.stdout)
    manifest_architectures(manifest)
    if not DIGEST.fullmatch(manifest.get("digest", "")):
        raise ValueError("Invalid registry image digest")
    return manifest["digest"], manifest


def create_image_tag(tag, digest, rolling=False):
    if not DIGEST.fullmatch(digest):
        raise ValueError("Invalid image digest")
    existing = authenticated_manifest(f"{IMAGE}:{tag}", missing=True)
    if existing:
        if existing[0] == digest:
            return
        if not rolling:
            raise ValueError(f"Numbered image tag {tag} is immutable")
    subprocess.run(["docker", "buildx", "imagetools", "create", "--tag", f"{IMAGE}:{tag}", f"{IMAGE}@{digest}"], check=True)
    if authenticated_manifest(f"{IMAGE}:{tag}")[0] != digest:
        raise ValueError("Published image tag digest mismatch")


def platform_digest(digest, architecture):
    if not DIGEST.fullmatch(digest) or "linux/" + architecture not in ARCHITECTURES:
        raise ValueError("Invalid image platform")
    actual, manifest = authenticated_manifest(f"{IMAGE}@{digest}")
    if actual != digest:
        raise ValueError("Candidate registry digest mismatch")
    selected = [item["digest"] for item in manifest["manifests"] if item["platform"]["architecture"] == architecture]
    if len(selected) != 1 or not DIGEST.fullmatch(selected[0]):
        raise ValueError("Missing image platform manifest")
    return selected[0]


def stage_distribution(version, ci_run, output, proof_path):
    if not VERSION.fullmatch(version):
        raise ValueError("Expected a stable numeric version")
    run = successful_run(ci_run, {".github/workflows/ci.yml", ".github/workflows/release.yml"})
    if run["head_sha"] != os.environ["GITHUB_SHA"]:
        raise ValueError("The runtime workflow must use the production-verified source revision")
    data, artifact = artifact_bytes(ci_run, "distribution")
    if artifact["workflow_run"]["head_sha"] != run["head_sha"]:
        raise ValueError("Distribution artifact revision mismatch")
    output.mkdir(parents=True, exist_ok=False)
    unpack_artifact(data, output)
    audit = subprocess.run([sys.executable, str(Path(__file__).with_name("publish-distribution.py")), str(output),
                            "--version", version, "--ci-run", str(ci_run)], capture_output=True, text=True, check=True)
    fingerprint = json.loads(audit.stdout)["fingerprint"]
    proof_path.parent.mkdir(parents=True, exist_ok=True)
    proof_path.write_text(json.dumps({"image": IMAGE, "version": version, "ci_run": int(ci_run),
        "source_sha": run["head_sha"], "source_repository": SOURCE_REPO,
        "source_url": "https://github.com/" + SOURCE_REPO + "/commit/" + run["head_sha"],
        "production_ci": run["html_url"], "license": "PolyForm-Noncommercial-1.0.0",
        "fingerprint": fingerprint, "artifact_digest": artifact["digest"]}, indent=2) + "\n")


def record_image(version, proof_path, digest):
    if not VERSION.fullmatch(version) or not DIGEST.fullmatch(digest):
        raise ValueError("Invalid runtime release reference")
    current = authenticated_manifest(f"{IMAGE}@{digest}")
    if current[0] != digest:
        raise ValueError("Candidate registry digest mismatch")
    create_image_tag(version, digest)
    proof = json.loads(proof_path.read_text())
    if proof["version"] != version:
        raise ValueError("Candidate version mismatch")
    proof.update(digest=digest, architectures=ARCHITECTURES)
    proof_path.write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"image": IMAGE, "version": version, "digest": digest}))


def promote_latest(version, ci_run, image_run):
    proof = check_image_release(version, ci_run, image_run)
    release = api(f"repos/{PUBLIC_REPO}/releases/latest")
    if release["tag_name"] != "v" + version or release["draft"] or release["prerelease"]:
        raise ValueError("Only the current stable public release may advance the image latest tag")
    create_image_tag("latest", proof["digest"], rolling=True)
    check_image_release(version, ci_run, image_run, latest=True)
    print(json.dumps({"image": IMAGE + ":latest", "digest": proof["digest"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["stage", "record", "latest", "platform"])
    parser.add_argument("--version", required=True)
    parser.add_argument("--ci-run", type=int)
    parser.add_argument("--image-run", type=int)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--proof", type=Path)
    parser.add_argument("--digest")
    parser.add_argument("--architecture")
    args = parser.parse_args()
    if args.operation == "stage":
        stage_distribution(args.version, args.ci_run, args.directory, args.proof)
    elif args.operation == "record":
        record_image(args.version, args.proof, args.digest)
    elif args.operation == "latest":
        promote_latest(args.version, args.ci_run, args.image_run)
    else:
        print(platform_digest(args.digest, args.architecture))


if __name__ == "__main__":
    main()
