"""Simulated agentbot worker for spike S5.

Waits STARTUP_SECONDS (simulated cold start), then polls /claim every second for up to
CLAIM_TIMEOUT_SECONDS. On a claim it touches /tmp/claimed (readiness), "works" for
WORK_SECONDS, reports /done and exits 0. With nothing to claim it exits 0.
"""
import json, os, time, urllib.request

BASE = os.environ.get("SCALE_URL", "http://orchestrator:8081")
TOKEN = os.environ["SCALE_TOKEN"]
NAME = os.environ.get("POD_NAME", "?")
STARTUP = float(os.environ.get("STARTUP_SECONDS", "0"))
CLAIM_TIMEOUT = float(os.environ.get("CLAIM_TIMEOUT_SECONDS", "20"))
WORK = float(os.environ.get("WORK_SECONDS", "60"))


def log(msg):
	print(time.strftime("%H:%M:%S"), NAME, msg, flush=True)


def post(path):
	req = urllib.request.Request(f"{BASE}{path}", data=b"", method="POST", headers={"Authorization": f"Bearer {TOKEN}"})
	with urllib.request.urlopen(req, timeout=5) as r:
		body = r.read()
		return r.status, (json.loads(body) if body else None)


log(f"start; startup={STARTUP}s claimTimeout={CLAIM_TIMEOUT}s work={WORK}s")
time.sleep(STARTUP)
deadline = time.time() + CLAIM_TIMEOUT
run = None
while time.time() < deadline:
	try:
		status, body = post(f"/claim?worker={NAME}")
		if status == 200:
			run = body["run"]
			break
	except Exception as e:
		log(f"claim error {e}")
	time.sleep(1)

if run is None:
	log("nothing to claim; exit 0")
	raise SystemExit(0)

open("/tmp/claimed", "w").close()
log(f"claimed run {run}; working")
time.sleep(WORK)
post(f"/done?run={run}&worker={NAME}")
log(f"run {run} done; exit 0")
