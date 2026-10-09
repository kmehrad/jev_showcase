// Browser front end: rendering, human input, game loop, and the optional agent bridge.
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const AGENT_MODE = params.get("agent") === "1";
  const LOCKSTEP = params.get("lockstep") === "1";
  const SPEED = Math.min(3, Math.max(0.1, parseFloat(params.get("speed")) || 1));
  const DECISION_EVERY = Math.max(1, parseInt(params.get("every"), 10) || 6); // frames between state posts
  const SEED = parseInt(params.get("seed"), 10) || Math.floor(Math.random() * 1e9);

  const DT = BreakoutEngine.DT;
  const engine = new BreakoutEngine({ seed: SEED });
  const W = engine.cfg.width;
  const H = engine.cfg.height;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const hud = {
    score: document.getElementById("score"),
    lives: document.getElementById("lives"),
    level: document.getElementById("level"),
    mode: document.getElementById("mode"),
  };

  // Render at device pixel ratio for crisp edges; draw in logical 800x600 units.
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // ---------------------------------------------------------------- human input
  const keys = new Set();
  const human = { mouseX: null, launchQueued: false };

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowleft", "arrowright", " ", "arrowup"].includes(k)) e.preventDefault();
    if (k === "arrowleft" || k === "a" || k === "arrowright" || k === "d") {
      keys.add(k);
      human.mouseX = null; // keyboard takes over from mouse
    }
    if (k === " " || k === "arrowup" || k === "w") human.launchQueued = true;
    if (k === "p" || k === "escape") engine.togglePause();
    if (k === "r") restart();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());

  function toGameX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }
  canvas.addEventListener("mousemove", (e) => (human.mouseX = toGameX(e.clientX)));
  canvas.addEventListener("touchmove", (e) => {
    human.mouseX = toGameX(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("click", () => {
    if (engine.status === "gameover") restart();
    else human.launchQueued = true;
  });
  canvas.addEventListener("touchstart", () => (human.launchQueued = true), { passive: true });

  function humanInput() {
    const left = keys.has("arrowleft") || keys.has("a");
    const right = keys.has("arrowright") || keys.has("d");
    const input = { move: (right ? 1 : 0) - (left ? 1 : 0), targetX: human.mouseX, launch: human.launchQueued };
    human.launchQueued = false;
    return input;
  }

  function restart() {
    engine.reset();
    agent.launchPending = false;
  }

  // ---------------------------------------------------------------- agent bridge
  // The page posts game state to the local server (server.py); an external agent
  // reads it from GET /api/state and replies with POST /api/action.
  const agent = {
    seq: 0,            // id of the latest state sent
    inflight: false,
    lastSentFrame: -Infinity,
    lastSentAt: 0,
    lastActionId: 0,
    ackSeq: 0,         // latest state seq the agent has answered
    move: 0,
    targetX: null,
    launchPending: false,
    status: "offline",
  };

  function agentBlocking() {
    // In lockstep mode the game waits for the agent to answer each state.
    return AGENT_MODE && LOCKSTEP && agent.seq > agent.ackSeq &&
      (engine.status === "playing" || engine.status === "ready");
  }

  function applyAction(rec) {
    if (!rec || !rec.id || rec.id === agent.lastActionId) return;
    agent.lastActionId = rec.id;
    agent.ackSeq = Math.max(agent.ackSeq, rec.for_seq || 0);
    agent.status = "connected";
    agent.targetX = Number.isFinite(rec.target_x) ? rec.target_x : null;
    switch (rec.action) {
      case "left": agent.move = -1; break;
      case "right": agent.move = 1; break;
      case "launch": agent.move = 0; agent.launchPending = true; break;
      case "restart": agent.move = 0; if (engine.status === "gameover") restart(); break;
      default: agent.move = 0;
    }
  }

  async function postState() {
    agent.inflight = true;
    const seq = ++agent.seq;
    agent.lastSentFrame = engine.frame;
    agent.lastSentAt = performance.now();
    try {
      const res = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seq, state: engine.getState() }),
      });
      applyAction(await res.json());
      // Lockstep: poll until the agent answers this state.
      while (LOCKSTEP && agent.ackSeq < seq && seq === agent.seq) {
        await new Promise((r) => setTimeout(r, 40));
        applyAction(await (await fetch("/api/action")).json());
        agent.status = agent.lastActionId ? "thinking" : "waiting for agent";
      }
      if (agent.status !== "connected" && !agent.lastActionId) agent.status = "waiting for agent";
    } catch (err) {
      agent.status = "server offline";
      agent.ackSeq = seq; // do not freeze the game when the server is gone
    } finally {
      agent.inflight = false;
    }
  }

  function maybePostState(now) {
    if (!AGENT_MODE || agent.inflight) return;
    const framesDue = engine.frame - agent.lastSentFrame >= DECISION_EVERY;
    const timeDue = now - agent.lastSentAt > 500; // keep the agent informed while paused/over
    if (framesDue || timeDue) postState();
  }

  function agentInput() {
    const input = { move: agent.move, targetX: agent.targetX, launch: agent.launchPending };
    if (agent.launchPending && engine.status === "ready") agent.launchPending = false;
    return input;
  }

  // ---------------------------------------------------------------- rendering
  const ROW_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"];

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  function render() {
    ctx.fillStyle = "#0b1020";
    ctx.fillRect(0, 0, W, H);

    for (const b of engine.bricks) {
      if (!b.alive) continue;
      ctx.fillStyle = ROW_COLORS[b.row % ROW_COLORS.length];
      roundRect(b.x, b.y, b.w, b.h, 4);
    }

    const p = engine.paddle;
    ctx.fillStyle = "#e5e7eb";
    roundRect(p.x, p.y, p.w, p.h, 7);

    const ball = engine.ball;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
    ctx.fill();

    const msg = {
      ready: AGENT_MODE ? "Waiting for agent to launch" : "Press Space or click to launch",
      paused: "Paused — press P to resume",
      gameover: `Game over — score ${engine.score}. Press R or click to restart`,
    }[engine.status];
    if (msg) {
      ctx.fillStyle = "rgba(11, 16, 32, 0.6)";
      ctx.fillRect(0, H / 2 - 30, W, 60);
      ctx.fillStyle = "#f3f4f6";
      ctx.font = "600 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(msg, W / 2, H / 2);
    }

    hud.score.textContent = engine.score;
    hud.lives.textContent = engine.lives;
    hud.level.textContent = engine.level;
    hud.mode.textContent = AGENT_MODE
      ? `Agent${LOCKSTEP ? " (lockstep)" : ""}: ${agent.status}`
      : "Human";
  }

  // ---------------------------------------------------------------- main loop
  let last = performance.now();
  let acc = 0;
  function loop(now) {
    acc += Math.min((now - last) / 1000, 0.25) * SPEED;
    last = now;
    while (acc >= DT) {
      if (agentBlocking()) { acc = 0; break; }
      engine.step(AGENT_MODE ? agentInput() : humanInput());
      acc -= DT;
      // Pause the catch-up loop so the agent sees this frame (only if we can post it now).
      if (AGENT_MODE && !agent.inflight && engine.frame - agent.lastSentFrame >= DECISION_EVERY) break;
    }
    acc = Math.min(acc, 0.25);
    maybePostState(now);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Handy hooks for in-page scripting and debugging from the browser console.
  window.breakout = { engine, getState: () => engine.getState(), restart, seed: SEED };
})();
