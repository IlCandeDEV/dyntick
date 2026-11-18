"""Check the actual production container, using only Python's standard library."""
from html.parser import HTMLParser
import gzip
import re
import sys
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag == "script" and data.get("src"):
            self.urls.append(data["src"])
        if tag == "link" and data.get("rel") in ("stylesheet", "icon", "modulepreload"):
            self.urls.append(data["href"])


base = sys.argv[1].rstrip("/") + "/"
with urlopen(urljoin(base, "healthz"), timeout=10) as response:
    assert response.status == 200 and response.read().strip() == b"ok"
with urlopen(base, timeout=10) as response:
    html = response.read().decode()
    assert response.status == 200
    assert '<html lang="en"' in html and "Dyntick" in html
    assert "script-src 'self'" in response.headers.get("Content-Security-Policy", "")
    assert response.headers.get("X-Content-Type-Options") == "nosniff"
    assert "no-cache" in response.headers.get("Cache-Control", "")

assets = Assets()
assets.feed(html)
assert any(path.endswith(".js") for path in assets.urls), "Missing JavaScript bundle"
assert any(path.endswith(".css") for path in assets.urls), "Missing CSS bundle"
checked = set()
gzip_checked = False
for path in assets.urls:
    target = urljoin(base, path)
    assert urlparse(target).netloc == urlparse(base).netloc, f"External asset: {target}"
    with urlopen(target, timeout=10) as response:
        content = response.read()
        assert response.status == 200 and content
        assert "text/html" not in response.headers.get("Content-Type", ""), target
        if path.endswith(".js") and len(content) > 1024 and not gzip_checked:
            with urlopen(Request(target, headers={"Accept-Encoding": "gzip"}), timeout=10) as compressed:
                assert compressed.headers.get("Content-Encoding") == "gzip", "Missing gzip response"
                assert gzip.decompress(compressed.read()) == content, "Gzip changed the asset contents"
                gzip_checked = True
        if path.endswith(".css"):
            for font in re.findall(r"url\(['\"]?([^)'\"]+\.woff2)['\"]?\)", content.decode()):
                font_url = urljoin(target, font)
                assert urlparse(font_url).netloc == urlparse(base).netloc
                with urlopen(font_url, timeout=10) as font_response:
                    assert font_response.status == 200 and font_response.read()
                checked.add(font_url)
    checked.add(target)
assert gzip_checked, "The production compression path was not exercised"
print(f"Production HTTP check passed: health, HTML, headers, gzip integrity and {len(checked)} local assets.")
