"""Example agent that plays Breakout through the local bridge (standard library only).

It uses a simple rule-based policy so the game/agent loop can be tested without an
API key. To plug in Jev later, replace `decide()` with a function that asks Jev
(via typesafe_sdk) for an action and returns the same dict shape.

Usage (with server.py running and http://localhost:8000/?agent=1 open):
    python breakout/agent_client.py
"""

import argparse
import json
import time
import urllib.request

BASE = "http://localhost:8000"


def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as res:
        return json.load(res)


def post_json(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.load(res)


def predict_landing_x(state):
    """Where the ball will cross the paddle's height, accounting for side-wall bounces."""
    ball, paddle, width = state["ball"], state["paddle"], state["width"]
    if ball["vy"] <= 0:
        return width / 2  # ball moving up: drift back toward the center
    t = (paddle["y"] - ball["r"] - ball["y"]) / ball["vy"]
    x = ball["x"] + ball["vx"] * t
    lo, hi = ball["r"], width - ball["r"]
    span = hi - lo
    x = (x - lo) % (2 * span)  # unfold reflections off the side walls
    return lo + (2 * span - x if x > span else x)


def densest_column_x(state):
    """x-coordinate of the brick column with the most bricks left."""
    b = state["bricks"]
    counts = [sum(row[c] for row in b["grid"]) for c in range(b["cols"])]
    col = max(range(b["cols"]), key=counts.__getitem__)
    return b["left"] + col * (b["brick_w"] + b["gap"]) + b["brick_w"] / 2


def decide(state):
    """Return {"action": left|right|stay|launch|restart, "target_x": float|None}."""
    if state["status"] == "ready":
        return {"action": "launch"}
    if state["status"] == "gameover":
        return {"action": "restart"}
    landing = predict_landing_x(state)
    # Hitting off-center angles the ball: catch it left of center to send it right, and vice versa.
    direction = 1 if densest_column_x(state) > landing else -1
    offset = 0.3 * state["paddle"]["w"] / 2 * direction
    return {"action": "stay", "target_x": landing - offset}


def main():
    global BASE
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=BASE)
    args = parser.parse_args()
    BASE = args.url.rstrip("/")

    last_seq = None
    print(f"Agent polling {BASE} — open {BASE}/?agent=1 in a browser. Ctrl+C to stop.")
    while True:
        snapshot = get_json("/api/state")
        seq, state = snapshot["seq"], snapshot["state"]
        if state is None or seq == last_seq:
            time.sleep(0.02)
            continue
        last_seq = seq
        if state["status"] == "paused":
            continue
        post_json("/api/action", {**decide(state), "for_seq": seq})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
