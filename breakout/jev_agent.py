"""Jev plays Breakout through the local bridge.

Routine steps (launch, waiting while the ball rises) are handled in code; while the
ball is falling, each new game state is turned into a small feature dict and Jev is
asked a Choice question: move the paddle left, right, or stay.

Usage (from jev_showcase/, with `python breakout/server.py` running and
http://localhost:8000/?agent=1&lockstep=1 open in a browser):

    uv run python breakout/jev_agent.py                       # relative features (default)
    uv run python breakout/jev_agent.py --features raw        # positions/velocities only
    uv run python breakout/jev_agent.py --features predicted  # adds the predicted landing point

Every Jev call is a billed API request; --max-calls caps the total (default 200).
Each decision is logged to breakout/runs/<timestamp>-<features>.jsonl.
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from typesafe_sdk import (
    Choice,
    TypeSafeAPIConnectionError,
    TypeSafeAPIError,
    TypeSafeAuthenticationError,
    TypeSafeClient,
    TypeSafePermissionDeniedError,
)

import agent_client as bridge

GAME_DIR = Path(__file__).resolve().parent
FPS = 60

MOVE_QUESTION = Choice(
    instructions=(
        "Decide how to move a Breakout paddle so it is underneath the ball when the ball "
        "comes down to the paddle. Horizontal offsets are in pixels; positive means right of "
        "the paddle center. The paddle covers paddle center plus or minus paddle_half_width_px."
    ),
    criteria={
        "left": "The ball will come down to the left of the paddle's span, so the paddle must move left.",
        "right": "The ball will come down to the right of the paddle's span, so the paddle must move right.",
        "stay": "The ball will come down within the paddle's span, so the paddle should not move.",
    },
)


def features(state, mode):
    """Compact state sent to Jev. `mode` controls how much is pre-computed in code."""
    ball, paddle = state["ball"], state["paddle"]
    f = {
        "ball_moving": "down" if ball["vy"] > 0 else "up",
        "paddle_half_width_px": paddle["w"] / 2,
    }
    if mode == "raw":
        f.update(
            ball_x=ball["x"],
            ball_y=ball["y"],
            ball_vx_px_per_s=ball["vx"],
            ball_vy_px_per_s=ball["vy"],
            paddle_center_x=paddle["center_x"],
            paddle_y=paddle["y"],
            board_width=state["width"],
        )
        return f
    f.update(
        ball_offset_from_paddle_center_px=round(ball["x"] - paddle["center_x"]),
        ball_horizontal_speed_px_per_frame=round(ball["vx"] / FPS, 1),
        frames_until_ball_reaches_paddle=round((paddle["y"] - ball["r"] - ball["y"]) / ball["vy"] * FPS),
    )
    if mode == "predicted":
        f["predicted_landing_offset_from_paddle_center_px"] = round(
            bridge.predict_landing_x(state) - paddle["center_x"]
        )
    return f


def oracle_move(state):
    """The correct answer to MOVE_QUESTION, computed from exact physics (for scoring Jev)."""
    offset = bridge.predict_landing_x(state) - state["paddle"]["center_x"]
    half = state["paddle"]["w"] / 2
    return "right" if offset > half else "left" if offset < -half else "stay"


def make_client():
    load_dotenv(GAME_DIR.parent / ".env", override=False)
    api_key = os.getenv("TYPESAFE_API_KEY", "").strip()
    if not api_key or api_key == "replace_with_your_real_key":
        sys.exit("Set TYPESAFE_API_KEY in jev_showcase/.env first.")
    model = os.getenv("TYPESAFE_DEFAULT_MODEL", "jev-latest").strip() or "jev-latest"
    return TypeSafeClient(api_key=api_key, model=model, timeout=10.0)


class Stats:
    def __init__(self):
        self.calls = self.errors = self.agree = self.low_conf = 0
        self.latencies = []
        self.lives_lost = 0
        self.score = 0
        self.level = 1

    def summary(self, mode):
        n = max(self.calls, 1)
        lat = sorted(self.latencies) or [0]
        return (
            f"features={mode} score={self.score} level={self.level} lives_lost={self.lives_lost} "
            f"jev_calls={self.calls} errors={self.errors} "
            f"agreement_with_physics={self.agree / n:.0%} low_confidence_holds={self.low_conf} "
            f"latency_ms median={lat[len(lat) // 2]:.0f} max={lat[-1]:.0f}"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=bridge.BASE)
    parser.add_argument("--features", choices=["raw", "relative", "predicted"], default="relative")
    parser.add_argument("--max-calls", type=int, default=200, help="stop after this many Jev calls")
    parser.add_argument("--min-confidence", type=float, default=0.6,
                        help="below this, keep the previous move instead of Jev's choice")
    parser.add_argument("--games", type=int, default=1, help="games to play before exiting")
    args = parser.parse_args()
    bridge.BASE = args.url.rstrip("/")

    client = make_client()
    runs = GAME_DIR / "runs"
    runs.mkdir(exist_ok=True)
    log_path = runs / f"{datetime.now():%Y%m%d-%H%M%S}-{args.features}.jsonl"
    stats = Stats()
    games_done = 0
    last_seq, last_lives, move = None, None, "stay"
    print(f"Jev agent ({args.features} features) polling {bridge.BASE}")
    print(f"Open {bridge.BASE}/?agent=1&lockstep=1 — logging to {log_path.relative_to(GAME_DIR.parent)}")

    try:
        with log_path.open("w") as log:
            while True:
                snapshot = bridge.get_json("/api/state")
                seq, state = snapshot["seq"], snapshot["state"]
                if state is None or seq == last_seq:
                    time.sleep(0.01)
                    continue
                last_seq = seq
                stats.score, stats.level = state["score"], state["level"]
                if last_lives is not None and state["lives"] < last_lives:
                    stats.lives_lost += last_lives - state["lives"]
                last_lives = state["lives"]

                status = state["status"]
                if status == "paused":
                    continue
                if status == "gameover":
                    games_done += 1
                    print(f"Game {games_done} over: {stats.summary(args.features)}")
                    if games_done >= args.games:
                        break
                    bridge.post_json("/api/action", {"action": "restart", "for_seq": seq})
                    last_lives = None
                    continue
                if status == "ready":
                    move = "stay"
                    bridge.post_json("/api/action", {"action": "launch", "for_seq": seq})
                    continue
                if state["ball"]["vy"] <= 0:  # ball rising: nothing to catch yet
                    move = "stay"
                    bridge.post_json("/api/action", {"action": move, "for_seq": seq})
                    continue
                if stats.calls >= args.max_calls:
                    print(f"Reached --max-calls {args.max_calls}; stopping (the game stays paused in lockstep).")
                    break

                feats = features(state, args.features)
                started = time.perf_counter()
                try:
                    result = client.system_one(state=feats, questions={"move": MOVE_QUESTION})
                except (TypeSafeAuthenticationError, TypeSafePermissionDeniedError) as exc:
                    sys.exit(f"Jev rejected the credentials or model access: HTTP {exc.status}")
                except (TypeSafeAPIConnectionError, TypeSafeAPIError) as exc:
                    stats.errors += 1
                    print(f"Jev call failed ({type(exc).__name__}); holding 'stay'")
                    bridge.post_json("/api/action", {"action": "stay", "for_seq": seq})
                    continue
                latency_ms = (time.perf_counter() - started) * 1000

                answer = result.answers["move"]
                if answer.confidence >= args.min_confidence:
                    move = answer.choice
                else:
                    stats.low_conf += 1  # keep the previous move rather than act on a guess
                oracle = oracle_move(state)
                stats.calls += 1
                stats.agree += answer.choice == oracle
                stats.latencies.append(latency_ms)
                bridge.post_json("/api/action", {"action": move, "for_seq": seq})

                log.write(json.dumps({
                    "seq": seq, "frame": state["frame"], "features": feats,
                    "choice": answer.choice, "confidence": round(answer.confidence, 3),
                    "probabilities": {k: round(v, 3) for k, v in answer.probabilities.items()},
                    "applied": move, "physics_answer": oracle, "latency_ms": round(latency_ms),
                    "model": result.model, "score": state["score"], "lives": state["lives"],
                }) + "\n")
                log.flush()

    except KeyboardInterrupt:
        print("\nStopped.")
    client.close()
    print(stats.summary(args.features))


if __name__ == "__main__":
    main()
