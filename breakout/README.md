# Breakout

A browser Breakout game with a small local bridge so an external agent (e.g. Jev) can play it.
No dependencies beyond Python 3 (standard library) and a modern browser.

## Play

```bash
python breakout/server.py          # from jev_showcase/ (or: uv run python breakout/server.py)
```

Open http://localhost:8000/

| Control | Action |
|---|---|
| ← / → or A / D, or mouse/touch | Move paddle |
| Space / ↑ / click | Launch ball |
| P / Esc | Pause |
| R | Restart |

6 rows × 10 bricks (top rows worth more), 3 lives. Clearing the board starts the next level with a faster ball.

## Let an agent play

1. Start the server: `python breakout/server.py`
2. Open http://localhost:8000/?agent=1
3. Run an agent: `python breakout/agent_client.py` (rule-based example; no API key needed)

URL options:

| Param | Default | Meaning |
|---|---|---|
| `agent=1` | off | Agent controls the paddle instead of keyboard/mouse |
| `lockstep=1` | off | Game pauses after each state until the agent answers — use for slow agents such as LLM calls |
| `every=N` | 6 | Frames between state posts (6 frames = 10 decisions/sec at 60 fps) |
| `speed=X` | 1 | Game-speed multiplier (0.1–3) |
| `seed=N` | random | Reproducible launch angles |

### Bridge API (http://localhost:8000)

| Endpoint | Used by | Body / response |
|---|---|---|
| `GET /api/state` | agent | `{"seq": int, "state": {...} \| null, "received_at": float}` |
| `POST /api/action` | agent | `{"action": "left"\|"right"\|"stay"\|"launch"\|"restart", "target_x": float?, "for_seq": int?}` |
| `POST /api/state` | browser | posts the state, gets the latest action back |
| `GET /api/action` | browser | latest action (polled in lockstep mode) |

`left`/`right`/`stay` persist until the next action. `target_x` (paddle centre, in px) overrides them and moves the paddle toward that x at max paddle speed. `launch` and `restart` are one-shot. `for_seq` tells lockstep mode which state the action answers.

State example (coordinates in a 800×600 board, origin top-left, velocities in px/s):

```json
{
  "frame": 210, "status": "playing", "score": 4, "lives": 3, "level": 1,
  "width": 800, "height": 600,
  "paddle": {"x": 345.0, "y": 560, "w": 110, "h": 14, "center_x": 400.0, "speed": 540},
  "ball": {"x": 412.3, "y": 301.8, "vx": 120.5, "vy": 339.2, "r": 7},
  "bricks": {"remaining": 58, "rows": 6, "cols": 10, "top": 70, "left": 30,
             "brick_w": 68.6, "brick_h": 22, "gap": 6, "grid": [[1,1,1,...], ...]}
}
```

`status` is one of `ready` (ball on paddle, waiting for `launch`), `playing`, `paused`, `gameover`.

### Jev as the player

```bash
python breakout/server.py                                   # terminal 1
# browser: http://localhost:8000/?agent=1&lockstep=1
uv run python breakout/jev_agent.py                         # terminal 2 (needs TYPESAFE_API_KEY in .env)
```

While the ball is falling, `jev_agent.py` sends Jev a small feature dict for each new state as the
`state` of `client.system_one(...)` and asks one `Choice` question: `left` / `right` / `stay`.
Launching and waiting while the ball rises are handled in code (no API call). Answers below
`--min-confidence` (default 0.6) keep the previous move. Every call is billed; `--max-calls`
(default 200) caps a run. `--features` picks how much is pre-computed:

| `--features` | Jev receives |
|---|---|
| `raw` | ball x/y/vx/vy, paddle centre, board width |
| `relative` (default) | ball offset from paddle centre, horizontal speed per frame, frames until the ball reaches the paddle |
| `predicted` | `relative` plus the predicted landing offset (wall bounces solved in code) |

Each call is logged to `breakout/runs/*.jsonl` (features, choice, probabilities, confidence,
latency, model) along with `physics_answer`, the exact answer computed from the trajectory;
the summary reports Jev's agreement with it.

See [JEV_PLAYER.md](JEV_PLAYER.md) for the full question, the state sent to Jev, a worked example, and results.


## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and layout |
| `engine.js` | Pure game logic (no DOM); also loadable in Node for headless simulation |
| `main.js` | Rendering, input, game loop, agent bridge client |
| `server.py` | Static file server + agent bridge |
| `agent_client.py` | Rule-based example agent and shared bridge helpers |
| `jev_agent.py` | Jev-controlled player (TypeSafe SDK) |
| `JEV_PLAYER.md` | How Jev plays: question, state, decision loop, results |

Headless simulation in Node:

```js
const BreakoutEngine = require("./breakout/engine.js");
const game = new BreakoutEngine({ seed: 1 });
game.step({ launch: true });
game.step({ move: 1 });               // or { targetX: 400 }
console.log(game.getState());
```
