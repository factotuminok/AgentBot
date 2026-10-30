"""Fake orchestrator /internal/scale for spike S5.

GET  /internal/scale  (bearer)  -> {"pendingRuns": P, "runningRuns": R}
POST /claim           (bearer)  -> 200 {"run": id} and pending-1, running+1; 204 when nothing pending
POST /done            (bearer)  -> running-1
POST /admin/set?pending=N       -> sets pending (no auth; spike only)
GET  /admin/state               -> {"pending":..,"running":..,"scalePolls":..,"unauthorized":..}
"""
import json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ["SCALE_TOKEN"]
lock = threading.Lock()
state = {"pending": 0, "running": 0, "nextRun": 1, "scalePolls": 0, "unauthorized": 0, "claims": 0, "emptyClaims": 0}


def log(msg):
	print(time.strftime("%H:%M:%S"), msg, flush=True)


class H(BaseHTTPRequestHandler):
	def log_message(self, *a):
		pass

	def send(self, code, body=None):
		data = b"" if body is None else json.dumps(body).encode()
		self.send_response(code)
		self.send_header("Content-Type", "application/json")
		self.send_header("Content-Length", str(len(data)))
		self.end_headers()
		self.wfile.write(data)

	def authed(self):
		if self.headers.get("Authorization") == f"Bearer {TOKEN}":
			return True
		with lock:
			state["unauthorized"] += 1
		log(f"401 {self.command} {self.path} auth={self.headers.get('Authorization')!r}")
		self.send(401, {"error": "unauthorized"})
		return False

	def do_GET(self):
		u = urlparse(self.path)
		if u.path == "/internal/scale":
			if not self.authed():
				return
			with lock:
				state["scalePolls"] += 1
				body = {"pendingRuns": state["pending"], "runningRuns": state["running"]}
			log(f"scale poll -> {body}")
			return self.send(200, body)
		if u.path == "/admin/state":
			with lock:
				return self.send(200, dict(state))
		self.send(404, {"error": "not found"})

	def do_POST(self):
		u = urlparse(self.path)
		q = parse_qs(u.query)
		if u.path == "/admin/set":
			with lock:
				state["pending"] = int(q["pending"][0])
				s = dict(state)
			log(f"admin set -> {s}")
			return self.send(200, s)
		if u.path == "/claim":
			if not self.authed():
				return
			worker = q.get("worker", ["?"])[0]
			with lock:
				if state["pending"] > 0:
					state["pending"] -= 1
					state["running"] += 1
					state["claims"] += 1
					run = state["nextRun"]
					state["nextRun"] += 1
				else:
					state["emptyClaims"] += 1
					run = None
			if run is None:
				return self.send(204)
			log(f"claim run={run} by {worker}")
			return self.send(200, {"run": run})
		if u.path == "/done":
			if not self.authed():
				return
			with lock:
				state["running"] = max(0, state["running"] - 1)
			log(f"done run={q.get('run', ['?'])[0]} by {q.get('worker', ['?'])[0]}")
			return self.send(200, {})
		self.send(404, {"error": "not found"})


log("fake scale listening on :8081")
ThreadingHTTPServer(("0.0.0.0", 8081), H).serve_forever()
