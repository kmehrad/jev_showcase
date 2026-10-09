"""Local server for the Breakout game and its agent bridge (standard library only).

Serves the game files and relays data between the browser and an external agent:

    browser  --POST /api/state-->   server   <--GET /api/state--   agent
    browser  <--(response)/GET /api/action--  server  <--POST /api/action--  agent

Run:  python breakout/server.py [--port 8000]
Then open http://localhost:8000/ (human) or http://localhost:8000/?agent=1 (agent).
"""

import argparse
import json
import socketserver
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

GAME_DIR = Path(__file__).resolve().parent
VALID_ACTIONS = {"left", "right", "stay", "launch", "restart"}
MAX_BODY = 64 * 1024

_lock = threading.Lock()
_state = {"seq": 0, "state": None, "received_at": None}
_action = {"id": 0, "action": "stay", "target_x": None, "for_seq": 0, "received_at": None}


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):  # keep the console quiet during play
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise ValueError("missing or oversized body")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError("body must be a JSON object")
        return data

    def do_GET(self):
        if self.path.startswith("/api/state"):
            with _lock:
                return self._send_json(dict(_state))
        if self.path.startswith("/api/action"):
            with _lock:
                return self._send_json(dict(_action))
        return super().do_GET()

    def do_POST(self):
        try:
            data = self._read_json()
        except (ValueError, json.JSONDecodeError) as exc:
            return self._send_json({"error": str(exc)}, status=400)

        if self.path == "/api/state":  # from the browser
            with _lock:
                _state.update(seq=int(data.get("seq", 0)), state=data.get("state"), received_at=time.time())
                return self._send_json(dict(_action))

        if self.path == "/api/action":  # from the agent
            action = data.get("action", "stay")
            if action not in VALID_ACTIONS:
                return self._send_json({"error": f"action must be one of {sorted(VALID_ACTIONS)}"}, status=400)
            target_x = data.get("target_x")
            if target_x is not None and not isinstance(target_x, (int, float)):
                return self._send_json({"error": "target_x must be a number or null"}, status=400)
            with _lock:
                _action.update(
                    id=_action["id"] + 1,
                    action=action,
                    target_x=target_x,
                    for_seq=int(data.get("for_seq") or _state["seq"]),
                    received_at=time.time(),
                )
                return self._send_json(dict(_action))

        return self._send_json({"error": "not found"}, status=404)


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # Skip HTTPServer's reverse-DNS lookup (socket.getfqdn), which can stall for
        # many seconds on some machines; the server name is not needed here.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    server = Server((args.host, args.port), partial(Handler, directory=str(GAME_DIR)))
    print(f"Breakout running at http://localhost:{args.port}/")
    print(f"Agent mode:        http://localhost:{args.port}/?agent=1   (add &lockstep=1 for slow agents)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
