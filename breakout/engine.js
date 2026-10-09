// Breakout game engine: pure game logic with no DOM access.
// Runs in the browser (window.BreakoutEngine) and in Node (module.exports),
// so the same rules can be simulated headlessly for testing or agent training.
(function (root) {
  "use strict";

  const DT = 1 / 60; // fixed simulation step in seconds

  const DEFAULTS = {
    width: 800,
    height: 600,
    paddleWidth: 110,
    paddleHeight: 14,
    paddleY: 560,
    paddleSpeed: 540, // px per second
    ballRadius: 7,
    ballSpeed: 360, // px per second at level 1
    speedPerLevel: 40,
    maxBallSpeed: 720,
    maxBounceAngle: Math.PI / 3, // 60 degrees from vertical at the paddle edge
    minBounceAngle: 0.12, // ~7 degrees, so the ball never gets stuck bouncing vertically
    brickRows: 6,
    brickCols: 10,
    brickHeight: 22,
    brickGap: 6,
    brickTop: 70,
    brickSide: 30,
    rowPoints: [7, 7, 5, 5, 3, 1],
    lives: 3,
    seed: 1,
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // Small seeded PRNG so runs are reproducible for a given seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class BreakoutEngine {
    constructor(options = {}) {
      this.cfg = { ...DEFAULTS, ...options };
      this.reset();
    }

    reset() {
      const c = this.cfg;
      this.rng = mulberry32(c.seed);
      this.score = 0;
      this.lives = c.lives;
      this.level = 1;
      this.frame = 0;
      this.events = []; // events from the most recent step (for sound/UI)
      this.paddle = {
        x: (c.width - c.paddleWidth) / 2,
        y: c.paddleY,
        w: c.paddleWidth,
        h: c.paddleHeight,
      };
      this.buildBricks();
      this.resetBall();
    }

    buildBricks() {
      const c = this.cfg;
      const totalGap = c.brickGap * (c.brickCols - 1);
      const w = (c.width - 2 * c.brickSide - totalGap) / c.brickCols;
      this.brickWidth = w;
      this.bricks = [];
      for (let row = 0; row < c.brickRows; row++) {
        for (let col = 0; col < c.brickCols; col++) {
          this.bricks.push({
            row,
            col,
            x: c.brickSide + col * (w + c.brickGap),
            y: c.brickTop + row * (c.brickHeight + c.brickGap),
            w,
            h: c.brickHeight,
            alive: true,
            points: c.rowPoints[row] ?? 1,
          });
        }
      }
      this.bricksRemaining = this.bricks.length;
    }

    resetBall() {
      const p = this.paddle;
      const r = this.cfg.ballRadius;
      this.ball = { x: p.x + p.w / 2, y: p.y - r - 1, vx: 0, vy: 0, r };
      this.status = "ready"; // ball rests on the paddle until launched
    }

    currentSpeed() {
      const c = this.cfg;
      return Math.min(c.ballSpeed + (this.level - 1) * c.speedPerLevel, c.maxBallSpeed);
    }

    launch() {
      if (this.status !== "ready") return;
      const angle = (this.rng() - 0.5) * (Math.PI / 3); // within +/-30 degrees
      const s = this.currentSpeed();
      this.ball.vx = s * Math.sin(angle);
      this.ball.vy = -s * Math.cos(angle);
      this.status = "playing";
      this.events.push("launch");
    }

    togglePause() {
      if (this.status === "playing") this.status = "paused";
      else if (this.status === "paused") this.status = "playing";
    }

    // Advance the game by one fixed step.
    // input: { move: -1 | 0 | 1, targetX: number | null, launch: boolean }
    // targetX (paddle center, in px) takes precedence over move when given.
    step(input = {}) {
      this.events = [];
      if (this.status === "paused" || this.status === "gameover") return;
      this.frame++;

      const c = this.cfg;
      const p = this.paddle;
      const maxDx = c.paddleSpeed * DT;
      let dx;
      if (input.targetX !== null && input.targetX !== undefined && Number.isFinite(input.targetX)) {
        dx = clamp(input.targetX - (p.x + p.w / 2), -maxDx, maxDx);
      } else {
        dx = clamp(input.move || 0, -1, 1) * maxDx;
      }
      p.x = clamp(p.x + dx, 0, c.width - p.w);

      if (this.status === "ready") {
        this.ball.x = p.x + p.w / 2;
        this.ball.y = p.y - this.ball.r - 1;
        if (input.launch) this.launch();
        return;
      }

      // Substep so a fast ball cannot tunnel through a brick or the paddle.
      const b = this.ball;
      const dist = Math.hypot(b.vx, b.vy) * DT;
      const n = Math.max(1, Math.ceil(dist / (b.r * 0.5)));
      for (let i = 0; i < n; i++) {
        b.x += (b.vx * DT) / n;
        b.y += (b.vy * DT) / n;
        this.collideWalls();
        this.collidePaddle();
        if (this.collideBricks()) {
          if (this.bricksRemaining === 0) {
            this.nextLevel();
            return;
          }
        }
        if (b.y - b.r > c.height) {
          this.loseLife();
          return;
        }
      }
    }

    collideWalls() {
      const b = this.ball;
      const W = this.cfg.width;
      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx = Math.abs(b.vx);
        this.events.push("wall");
      } else if (b.x + b.r > W) {
        b.x = W - b.r;
        b.vx = -Math.abs(b.vx);
        this.events.push("wall");
      }
      if (b.y - b.r < 0) {
        b.y = b.r;
        b.vy = Math.abs(b.vy);
        this.events.push("wall");
      }
    }

    collidePaddle() {
      const b = this.ball;
      const p = this.paddle;
      if (b.vy <= 0) return;
      if (!circleHitsRect(b, p)) return;
      if (b.y > p.y + p.h / 2) return; // already past the paddle's top half
      // Bounce angle depends on where the ball meets the paddle.
      const offset = clamp((b.x - (p.x + p.w / 2)) / (p.w / 2), -1, 1);
      let angle = offset * this.cfg.maxBounceAngle;
      if (Math.abs(angle) < this.cfg.minBounceAngle) {
        angle = Math.sign(offset || b.vx || this.rng() - 0.5) * this.cfg.minBounceAngle;
      }
      const s = this.currentSpeed();
      b.vx = s * Math.sin(angle);
      b.vy = -s * Math.cos(angle);
      b.y = p.y - b.r;
      this.events.push("paddle");
    }

    collideBricks() {
      const b = this.ball;
      for (const brick of this.bricks) {
        if (!brick.alive || !circleHitsRect(b, brick)) continue;
        brick.alive = false;
        this.bricksRemaining--;
        this.score += brick.points;
        this.events.push("brick");
        // Reflect along the axis of least penetration.
        const overlapX = Math.min(b.x + b.r - brick.x, brick.x + brick.w - (b.x - b.r));
        const overlapY = Math.min(b.y + b.r - brick.y, brick.y + brick.h - (b.y - b.r));
        if (overlapX < overlapY) {
          b.vx = b.x < brick.x + brick.w / 2 ? -Math.abs(b.vx) : Math.abs(b.vx);
        } else {
          b.vy = b.y < brick.y + brick.h / 2 ? -Math.abs(b.vy) : Math.abs(b.vy);
        }
        return true; // at most one brick per substep
      }
      return false;
    }

    nextLevel() {
      this.level++;
      this.events.push("level");
      this.buildBricks();
      this.resetBall();
    }

    loseLife() {
      this.lives--;
      this.events.push("life_lost");
      if (this.lives <= 0) {
        this.lives = 0;
        this.status = "gameover";
        this.events.push("gameover");
      } else {
        this.resetBall();
      }
    }

    // Compact, JSON-serializable snapshot for agents.
    getState() {
      const c = this.cfg;
      const p = this.paddle;
      const b = this.ball;
      const grid = [];
      for (let row = 0; row < c.brickRows; row++) {
        grid.push(this.bricks.slice(row * c.brickCols, (row + 1) * c.brickCols).map((k) => (k.alive ? 1 : 0)));
      }
      const round = (v) => Math.round(v * 10) / 10;
      return {
        frame: this.frame,
        status: this.status,
        score: this.score,
        lives: this.lives,
        level: this.level,
        width: c.width,
        height: c.height,
        paddle: { x: round(p.x), y: p.y, w: p.w, h: p.h, center_x: round(p.x + p.w / 2), speed: c.paddleSpeed },
        ball: { x: round(b.x), y: round(b.y), vx: round(b.vx), vy: round(b.vy), r: b.r },
        bricks: {
          remaining: this.bricksRemaining,
          rows: c.brickRows,
          cols: c.brickCols,
          top: c.brickTop,
          left: c.brickSide,
          brick_w: round(this.brickWidth),
          brick_h: c.brickHeight,
          gap: c.brickGap,
          grid,
        },
      };
    }
  }

  function circleHitsRect(c, r) {
    const nx = clamp(c.x, r.x, r.x + r.w);
    const ny = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - nx;
    const dy = c.y - ny;
    return dx * dx + dy * dy <= c.r * c.r;
  }

  BreakoutEngine.DT = DT;
  BreakoutEngine.DEFAULTS = DEFAULTS;

  if (typeof module !== "undefined" && module.exports) module.exports = BreakoutEngine;
  else root.BreakoutEngine = BreakoutEngine;
})(typeof globalThis !== "undefined" ? globalThis : this);
