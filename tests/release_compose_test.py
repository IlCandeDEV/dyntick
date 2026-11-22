import importlib.util
import hashlib
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import sys
from types import SimpleNamespace

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "scripts"))
import runtime_image
spec = importlib.util.spec_from_file_location("release_compose", root / "scripts/release-compose.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
publisher_spec = importlib.util.spec_from_file_location("publisher", root / "scripts/publish-distribution.py")
publisher = importlib.util.module_from_spec(publisher_spec)
publisher_spec.loader.exec_module(publisher)


class ReleaseComposeTest(unittest.TestCase):
    def test_source_and_distribution_share_a_pinned_runtime_base(self):
        source = (root / "Dockerfile").read_text()
        distribution = (root / "deploy/distribution.Dockerfile").read_text()
        source_base = [line for line in source.splitlines() if line.startswith("FROM ")][-1].split(" AS ")[0][5:]
        distribution_base = distribution.splitlines()[0][5:]
        self.assertEqual(source_base, distribution_base)
        self.assertRegex(source_base, r"^oven/bun:1\.4\.4-alpine@sha256:[0-9a-f]{64}$")
        for dockerfile in [source, distribution]:
            self.assertIn("USER 1000", dockerfile)
            self.assertIn("http://127.0.0.1:8080/healthz", dockerfile)
            self.assertIn("DATABASE_PATH=/data/dyntick.sqlite", dockerfile)
            self.assertNotIn("VOLUME ", dockerfile)

    def test_release_caption_uses_only_the_requested_versions_bullets(self):
        changelog = "# Dyntick 1.3.0\n\n- Sliding pages.\n- Softer numerals.\n\n# Dyntick 1.2.0\n\n- An older change.\n"
        self.assertEqual(publisher.release_caption("1.3.0", changelog),
                         "Welcome to Dyntick v. 1.3.0  \n"
                         "A simple yet functional space to study.\n\n"
                         "This version includes:\n\n- Sliding pages.\n- Softer numerals.\n")

    def test_release_caption_rejects_missing_empty_or_ambiguous_changes(self):
        for changelog in ["# Dyntick 1.2.0\n- Older release.\n", "# Dyntick 1.3.0\n",
                          "# Dyntick 1.3.0\nUnlisted changes.\n",
                          "# Dyntick 1.3.0\n- Change.\n# Dyntick 1.3.0\n- Duplicate.\n"]:
            with self.subTest(changelog=changelog), self.assertRaises(ValueError):
                publisher.release_caption("1.3.0", changelog)

    def test_release_caption_rejects_private_metadata_before_publication(self):
        for detail in ["/Users/private/project", "https://github.com/example/project-source",
                       "student@gmail.com", "ghp_" + "x" * 40]:
            with self.subTest(detail=detail), self.assertRaisesRegex(ValueError, "Private metadata"):
                publisher.release_caption("1.3.0", f"# Dyntick 1.3.0\n- {detail}\n")

    def test_distribution_audit_runs_without_notes_and_accepts_public_bullets(self):
        command = ["publish-distribution.py", ".", "--version", "1.3.0", "--ci-run", "123"]
        notes = "- Sliding pages.\n- Softer numerals."
        for extra in [[], ["--release-notes=" + notes]]:
            with self.subTest(extra=extra), patch.object(sys, "argv", command + extra), \
                    patch.object(publisher, "audited_files", return_value={"server.js": b"bundled"}), \
                    patch.object(Path, "read_text", side_effect=AssertionError("No changelog was supplied")), \
                    redirect_stdout(StringIO()) as output:
                publisher.main()
                result = json.loads(output.getvalue())
                if extra:
                    self.assertEqual(result["release_notes"], publisher.release_caption("1.3.0", f"# Dyntick 1.3.0\n{notes}"))
                else:
                    self.assertNotIn("release_notes", result)

    def test_publication_requires_explicit_valid_release_notes_before_network_calls(self):
        command = ["publish-distribution.py", ".", "--version", "1.3.0", "--ci-run", "123", "--publish"]
        for extra in [[], ["--changelog", "RELEASE_NOTES.md"]]:
            with self.subTest(extra=extra), patch.object(sys, "argv", command + extra), \
                    patch.object(publisher, "api") as api, redirect_stderr(StringIO()) as error:
                with self.assertRaises(SystemExit):
                    publisher.main()
                self.assertIn("Publication requires approved text via --release-notes", error.getvalue())
                api.assert_not_called()
        with patch.object(sys, "argv", command + ["--release-notes=- Public.\n# Internal"]), \
                patch.object(publisher, "api") as api:
            with self.assertRaisesRegex(ValueError, "nonempty bullet points"):
                publisher.main()
            api.assert_not_called()

    def test_default_pulls_latest_without_a_server_build(self):
        source = (root / "compose.yaml").read_text()
        self.assertIn("image: ghcr.io/ilcandedev/dyntick-runtime:${DYNTICK_VERSION:-latest}", source)
        self.assertIn("pull_policy: always", source)
        self.assertNotRegex(source, r"(?m)^\s*build:")
        self.assertNotIn("network.host", source)
        self.assertIn("dyntick-data:/data", source)

    def test_pinned_release_preserves_ports_and_container_options(self):
        source = (root / "compose.yaml").read_text()
        rendered = module.render_compose(source, "2.3.4")
        self.assertEqual(rendered, source.replace("${DYNTICK_VERSION:-latest}", "${DYNTICK_VERSION:-2.3.4}"))
        self.assertEqual(rendered.count("${DYNTICK_VERSION:-2.3.4}"), 1)
        self.assertNotIn("latest", rendered)

    def test_existing_pinned_template_can_target_another_release(self):
        source = (root / "compose.yaml").read_text()
        pinned = module.render_compose(source, "1.1.0")
        self.assertEqual(module.render_compose(pinned, "1.2.0"), module.render_compose(source, "1.2.0"))

    def test_invalid_or_incomplete_versions_are_rejected(self):
        source = (root / "compose.yaml").read_text()
        for version in ["latest", "v1.1.0", "1.1", "1.1.0-rc1", "1.1.0\n", "../main"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                module.render_compose(source, version)
        with self.assertRaises(ValueError):
            module.render_compose(source.replace("${DYNTICK_VERSION:-latest}", "latest", 1), "1.1.0")

    def test_numbered_tags_are_immutable(self):
        with patch.object(publisher, "api", return_value={"object": {"type": "commit", "sha": "old"}}) as api:
            with self.assertRaisesRegex(ValueError, "immutable"):
                publisher.tag("1.1.0", "new")
            self.assertEqual(api.call_count, 1, "Refusing a version change must not write to GitHub")

    def test_only_latest_can_be_moved(self):
        with patch.object(publisher, "api", return_value={"object": {"type": "commit", "sha": "old"}}) as api:
            publisher.tag("latest", "new")
            api.assert_called_with("repos/IlCandeDEV/dyntick/git/refs/tags/latest", "PATCH", {"sha": "new", "force": True})

    def test_image_proof_binds_version_ci_artifact_source_and_platforms(self):
        proof = {"image": runtime_image.IMAGE, "version": "1.5.0", "ci_run": 123,
                 "fingerprint": "audited", "source_sha": "source", "digest": "sha256:" + "a" * 64,
                 "source_repository": runtime_image.SOURCE_REPO,
                 "source_url": "https://github.com/" + runtime_image.SOURCE_REPO + "/commit/source",
                 "license": "PolyForm-Noncommercial-1.0.0",
                 "architectures": runtime_image.ARCHITECTURES}
        runtime_image.validate_proof(proof, "1.5.0", 123, "audited", "source")
        for field, wrong in [("image", "another/image"), ("version", "1.4.0"), ("ci_run", 122),
                             ("fingerprint", "other files"), ("source_sha", "other source"),
                             ("source_repository", "other/repository"), ("source_url", "another/url"), ("license", "MIT"),
                             ("architectures", ["linux/amd64"]), ("digest", "latest")]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime_image.validate_proof(dict(proof, **{field: wrong}), "1.5.0", 123, "audited", "source")

    def test_runtime_index_rejects_missing_platforms_and_private_attestations(self):
        platforms = [{"platform": {"os": "linux", "architecture": arch}} for arch in ["amd64", "arm64"]]
        self.assertEqual(runtime_image.manifest_architectures({"manifests": platforms}), runtime_image.ARCHITECTURES)
        for manifest in [platforms[:1], platforms + [{"platform": {"os": "unknown", "architecture": "unknown"}}]]:
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                runtime_image.manifest_architectures({"manifests": manifest})

    def test_numbered_image_tags_cannot_be_overwritten(self):
        old, new = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        with patch.object(runtime_image, "authenticated_manifest", return_value=(old, {})), patch.object(runtime_image.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "immutable"):
                runtime_image.create_image_tag("1.5.0", new)
            runtime_image.create_image_tag("1.5.0", old)
            command.assert_not_called()

    def test_latest_image_promotion_uses_the_numeric_release_tag(self):
        digest = "sha256:" + "a" * 64
        release = {"tag_name": "2.0.0", "draft": False, "prerelease": False}
        with patch.object(runtime_image, "api", return_value=release), \
                patch.object(runtime_image, "check_image_release", return_value={"digest": digest}), \
                patch.object(runtime_image, "create_image_tag") as tag, redirect_stdout(StringIO()):
            runtime_image.promote_latest("2.0.0", 123, 456)
            tag.assert_called_once_with("latest", digest, rolling=True)

    def test_public_audit_rejects_extra_files_private_metadata_and_nonempty_readme(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / "site").mkdir()
            (stage / "site/index.html").write_text("<html></html>")
            for name in ["Dockerfile", "README.md", "server.js"]:
                (stage / name).write_text("")
            (stage / "compose.yaml").write_text((root / "compose.yaml").read_text())
            self.assertEqual(len(publisher.audited_files(stage)), 5)
            for path, content in [("README.md", "private docs"), ("site/index.html", "/Users/private/path"), ("AGENTS.md", "private instructions")]:
                target = stage / path
                previous = target.read_text() if target.exists() else None
                target.write_text(content)
                with self.subTest(path=path), self.assertRaises(ValueError):
                    publisher.audited_files(stage)
                if previous is None:
                    target.unlink()
                else:
                    target.write_text(previous)

    def test_release_attachments_accept_only_the_matching_compose(self):
        compose = b"services:\n  dyntick:\n    image: example:2.0.0\n"
        release = {"assets": [{"name": "compose.yaml", "id": 123}]}
        with patch.object(publisher.subprocess, "run", return_value=SimpleNamespace(stdout=compose)):
            publisher.verify_release_assets(release, {"compose.yaml": compose})
            with self.assertRaisesRegex(ValueError, "differs"):
                publisher.verify_release_assets(release, {"compose.yaml": b"changed"})

    def test_release_attachments_reject_extra_missing_or_duplicate_files(self):
        compose = {"name": "compose.yaml", "id": 123}
        for assets in [[], [compose, {"name": "runtime-image.json", "id": 124}],
                       [compose, {"name": "notes.md", "id": 125}], [compose, compose]]:
            with self.subTest(assets=assets), patch.object(publisher.subprocess, "run") as download:
                with self.assertRaisesRegex(ValueError, "only compose.yaml"):
                    publisher.verify_release_assets({"assets": assets}, {"compose.yaml": b"compose"})
                download.assert_not_called()

    def _archive_fixture(self):
        source, digest = "b" * 40, "sha256:" + "d" * 64
        proof = {"image": runtime_image.IMAGE, "version": "2.0.0", "ci_run": 123,
            "fingerprint": "f" * 64, "artifact_digest": "sha256:" + "a" * 64,
            "source_sha": source, "digest": digest, "source_repository": runtime_image.SOURCE_REPO,
            "source_url": f"https://github.com/{runtime_image.SOURCE_REPO}/commit/{source}",
            "license": "PolyForm-Noncommercial-1.0.0", "architectures": runtime_image.ARCHITECTURES}
        release = {"tag_name": "2.0.0", "draft": False, "prerelease": False,
            "assets": [{"name": "compose.yaml", "id": 100}, {"name": "runtime-image.json", "id": 101}]}
        def read_api(path):
            if path == f"repos/{runtime_image.PUBLIC_REPO}/releases/tags/2.0.0":
                return release
            if path == f"repos/{runtime_image.PUBLIC_REPO}/git/ref/tags/2.0.0":
                return {"object": {"type": "commit", "sha": source}}
            raise AssertionError("Unexpected API request: " + path)
        return proof, release, source, digest, read_api

    def test_archive_preserves_original_runtime_proof_bytes(self):
        proof, release, source, digest, read_api = self._archive_fixture()
        original = (json.dumps(proof, indent=4) + "\n").encode()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_image, "api", side_effect=read_api), \
                patch.object(runtime_image.subprocess, "run", return_value=SimpleNamespace(stdout=original)), \
                patch.object(runtime_image, "successful_run", return_value={"head_sha": source}), \
                patch.object(runtime_image, "anonymous_manifest", return_value=(digest, {})):
            output = Path(directory) / "artifact"
            record = runtime_image.archive_release_proof("2.0.0", output)
            self.assertEqual([p.name for p in output.iterdir()], ["runtime-image.json"])
            self.assertEqual((output / "runtime-image.json").read_bytes(), original)
            self.assertEqual(record["sha256"], hashlib.sha256(original).hexdigest())
            self.assertEqual(record["release_asset_id"], 101)

    def test_archive_rejects_verification_of_another_source_commit(self):
        proof, release, source, digest, read_api = self._archive_fixture()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_image, "api", side_effect=read_api), \
                patch.object(runtime_image.subprocess, "run", return_value=SimpleNamespace(stdout=json.dumps(proof).encode())), \
                patch.object(runtime_image, "successful_run", return_value={"head_sha": "c" * 40}), \
                patch.object(runtime_image, "anonymous_manifest") as registry:
            output = Path(directory) / "artifact"
            with self.assertRaisesRegex(ValueError, "source commit"):
                runtime_image.archive_release_proof("2.0.0", output)
            registry.assert_not_called()
            self.assertFalse(output.exists())

    def test_archive_rejects_an_image_that_differs_from_the_proof(self):
        proof, release, source, digest, read_api = self._archive_fixture()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_image, "api", side_effect=read_api), \
                patch.object(runtime_image.subprocess, "run", return_value=SimpleNamespace(stdout=json.dumps(proof).encode())), \
                patch.object(runtime_image, "successful_run", return_value={"head_sha": source}), \
                patch.object(runtime_image, "anonymous_manifest", return_value=("sha256:" + "e" * 64, {})):
            output = Path(directory) / "artifact"
            with self.assertRaisesRegex(ValueError, "numbered image"):
                runtime_image.archive_release_proof("2.0.0", output)
            self.assertFalse(output.exists())

    def test_archive_requires_one_existing_runtime_proof(self):
        proof, release, source, digest, read_api = self._archive_fixture()
        release["assets"] = [{"name": "compose.yaml", "id": 100}]
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime_image, "api", side_effect=read_api), \
                patch.object(runtime_image.subprocess, "run") as download:
            with self.assertRaisesRegex(ValueError, "one runtime-image.json"):
                runtime_image.archive_release_proof("2.0.0", Path(directory) / "artifact")
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
