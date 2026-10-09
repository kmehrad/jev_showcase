# How Jev plays Breakout

`jev_agent.py` lets TypeSafe's Jev model control the Breakout paddle. Each decision is one
`client.system_one(...)` call with a small feature dict as `state` and a single **Choice**
question: `left`, `right`, or `stay`. Score and Noul questions are not used.

## The question

Defined as `MOVE_QUESTION` in `jev_agent.py`:

```python
Choice(
    instructions=(
        "Decide how to move a Breakout paddle so it is underneath the ball when the ball "
        "comes down to the paddle. Horizontal offsets are in pixels; positive means right of "
        "the paddle center. The paddle covers paddle center plus or minus paddle_half_width_px."
    ),
    criteria={
        "left":  "The ball will come down to the left of the paddle's span, so the paddle must move left.",
        "right": "The ball will come down to the right of the paddle's span, so the paddle must move right.",
        "stay":  "The ball will come down within the paddle's span, so the paddle should not move.",
    },
)
```

Choice fits because the paddle has three discrete moves. It also returns a probability for each
option and a `confidence` value, which the agent uses to ignore unsure answers.

## The state sent to Jev

The full game state (see the bridge API in [README.md](README.md)) includes 60 brick cells and raw
pixel coordinates, most of which do not matter for moving the paddle. The `features()` function
reduces it to a small dict, which is sent as:

```python
client.system_one(state=features(state, mode), questions={"move": MOVE_QUESTION})
```

`--features` chooses how much is computed in code before Jev sees the state:

| Mode | Fields sent to Jev |
|---|---|
| `raw` | `ball_moving`, `paddle_half_width_px`, `ball_x`, `ball_y`, `ball_vx_px_per_s`, `ball_vy_px_per_s`, `paddle_center_x`, `paddle_y`, `board_width` |
| `relative` (default) | `ball_moving`, `paddle_half_width_px`, `ball_offset_from_paddle_center_px`, `ball_horizontal_speed_px_per_frame`, `frames_until_ball_reaches_paddle` |
| `predicted` | `relative` plus `predicted_landing_offset_from_paddle_center_px` (landing point computed in code, including side-wall bounces) |

## A real decision

From a test run in `relative` mode (`breakout/runs/20261008-180019-relative.jsonl`):

```json
"features": {
  "ball_moving": "down",
  "paddle_half_width_px": 55.0,
  "ball_offset_from_paddle_center_px": 209,
  "ball_horizontal_speed_px_per_frame": -4.2,
  "frames_until_ball_reaches_paddle": 70
}
"choice": "right", "probabilities": {"left": 0.21, "right": 0.76, "stay": 0.03}, "confidence": 0.64
"physics_answer": "left"
```

The ball is 209 px right of the paddle center but moving left. In 70 frames it moves about
294 px left, so it lands about 85 px left of the paddle center, outside the paddle's 55 px
half-width. The correct move is `left`. Jev answered `right`: it went by where the ball is
now rather than extrapolating where it will be.

## The decision loop

1. The browser posts the game state to `server.py` every 6 frames (`?every=6`). With
   `?lockstep=1` the game waits until the agent answers that state.
2. `jev_agent.py` reads the state from `GET /api/state` and decides whether Jev is needed:

   | Game situation | Action | Source |
   |---|---|---|
   | Ball resting on the paddle (`ready`) | `launch` | code |
   | Ball moving up | `stay` | code |
   | Ball falling | `left` / `right` / `stay` | **Jev** |
   | Game over | stop (or `restart` with `--games N`) | code |

3. If Jev's `confidence` is at least `--min-confidence` (default 0.6), its choice is applied;
   otherwise the previous move is kept.
4. The move is sent with `POST /api/action`. The paddle keeps moving that way until the next
   decision, about 6 frames later.
5. API errors fall back to `stay` so lockstep never freezes; bad credentials stop the agent.
   `--max-calls` (default 200) caps billed calls.

## Logging and evaluation

Each Jev call writes one line to `breakout/runs/<timestamp>-<features>.jsonl` with the features
sent, Jev's choice, probabilities, confidence, the move applied, latency, resolved model, score
and lives. It also records `physics_answer`: the correct move computed in code from the ball's
exact trajectory. The end-of-run summary reports how often Jev agreed with it.

## Results so far

| Measure | Value |
|---|---|
| Latency per call | about 110–190 ms (median 147 ms, max 333 ms in the live run) |
| Input tokens per call | about 480 |
| Live run (`relative`, lockstep, 80 calls) | score 147, 0 lives lost, 0 errors |
| Agreement with `physics_answer` | 41% |
| Answers below the confidence threshold | 37 of 80 |

Jev mostly chases the ball's current position. That still kept the ball in play early in
level 1, because the paddle is wide and the ball is slow, but it is likely to cost lives as the
ball speeds up.

## Possible next steps

- **Compare feature modes** on the same seed (`--features raw`, `relative`, `predicted`).
  `predicted` should fix most wrong answers: code computes the landing point, and Jev only
  compares it with the paddle's span.
- **Score instead of Choice:** a rubric of about 8 board zones from left to right. The expected
  score converts directly into a `target_x` for the paddle, using Jev's full probability
  distribution rather than only the top choice.

## Running it

```bash
python breakout/server.py                      # terminal 1, from jev_showcase/
# browser: http://localhost:8000/?agent=1&lockstep=1
uv run python breakout/jev_agent.py            # terminal 2; needs TYPESAFE_API_KEY in .env
```
