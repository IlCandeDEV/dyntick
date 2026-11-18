"""Exercise the real container API and prove its named volume survives recreation."""
import argparse
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
from uuid import uuid4


def request(base, path="/api/state", payload=None):
    headers = {"Cache-Control": "no-cache"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers.update({"Content-Type": "application/json", "X-Dyntick-Request": "1", "Origin": base})
    with urlopen(Request(base + path, data=data, headers=headers), timeout=20) as response:
        assert response.status == 200
        assert response.headers.get("Cache-Control") == "no-store"
        return json.load(response)


def command(base, state, action):
    return request(base, "/api/action", {"requestId": str(uuid4()), "instanceId": state["instanceId"],
        "revision": state["revision"], "action": action})


def durable(state):
    return {key: state[key] for key in ["schemaVersion", "instanceId", "revision", "initialized", "preferences", "timer", "activity"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["seed", "check"])
    parser.add_argument("url")
    parser.add_argument("proof", type=Path)
    args = parser.parse_args()
    base = args.url.rstrip("/")
    if args.operation == "seed":
        state = request(base)
        completion_id = "container-check-" + str(uuid4())
        completion = {"id": completion_id, "completedAt": int(time.time() * 1000) - 60_000, "minutes": 17}
        imported = {"requestId": str(uuid4()), "instanceId": state["instanceId"],
            "activity": {"version": 1, "entries": {completion_id: completion}}}
        state = request(base, "/api/import", imported)
        assert state["activity"]["entries"][completion_id] == completion
        once = durable(state)
        assert durable(request(base, "/api/import", imported)) == once, "Import retry duplicated data"
        state = command(base, state, {"type": "preferences", "patch": {
            "language": "de", "theme": "dark", "focusMinutes": 35, "soundEnabled": False}})
        state = command(base, state, {"type": "reset"})
        state = command(base, state, {"type": "start"})
        state = command(base, state, {"type": "pause"})
        assert state["timer"]["status"] == "paused"
        assert state["timer"]["remainingMs"] > 0
        args.proof.parent.mkdir(parents=True, exist_ok=True)
        args.proof.write_text(json.dumps({"state": durable(state), "import": imported}, indent=2) + "\n")
        print("Seeded server preferences, a paused timer and one idempotent activity import.")
    else:
        proof = json.loads(args.proof.read_text())
        actual = request(base)
        assert durable(actual) == proof["state"], "SQLite data changed or disappeared after container recreation"
        # A second independent HTTP client needs neither browser data nor credentials.
        assert durable(request(base)) == proof["state"], "Independent client saw different data"
        assert durable(request(base, "/api/import", proof["import"])) == proof["state"], "Import idempotency did not survive restart"
        print("Verified persistent SQLite identity, preferences, paused session, activity and import idempotency.")


if __name__ == "__main__":
    main()
