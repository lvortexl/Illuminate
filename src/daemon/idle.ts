/**
 * Fires `onIdle` when there are genuinely no open connections for
 * `idleMs`, tracked by explicit `enter()`/`exit()` calls rather than reset-
 * on-every-request — the server is long-poll-shaped, so "idle" means "no
 * open connections", not "no recent request".
 *
 * Race-free by construction: `enter()` synchronously cancels any pending
 * timer, and the timer callback itself rechecks `activeCount` (and clears
 * its own reference) before firing, so a connection landing in the gap
 * between "timer scheduled" and "timer fires" can never race a stale fire,
 * and the controller remains correctly re-armable afterward.
 *
 * Production default `idleMs` (45 minutes, overridable via
 * `ILLUMINATE_IDLE_TIMEOUT_MS`) belongs in the daemon entry point, not
 * here — this class stays a pure, timeout-agnostic controller.
 */
export class IdleController {
  #activeCount = 0;
  #timer: NodeJS.Timeout | null = null;
  #idleMs: number;
  #onIdle: () => void;

  constructor(idleMs: number, onIdle: () => void) {
    this.#idleMs = idleMs;
    this.#onIdle = onIdle;
    this.#armIfIdle();
  }

  enter(): void {
    this.#activeCount++;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  exit(): void {
    this.#activeCount = Math.max(0, this.#activeCount - 1);
    this.#armIfIdle();
  }

  /**
   * Exposed so the daemon's real `onIdle` handler (wired in a later plan)
   * can perform a final belt-and-braces recheck before calling
   * `server.close()`, without duplicating this class's own counting logic.
   */
  get activeCount(): number {
    return this.#activeCount;
  }

  #armIfIdle(): void {
    if (this.#activeCount > 0 || this.#timer) return;
    this.#timer = setTimeout(() => {
      // Recheck at fire time, not just at schedule time, and clear the
      // reference in both outcomes so the controller can always be
      // correctly re-armed by a later exit() — a connection that landed
      // via enter() already cancelled this callback outright; this recheck
      // is the second, defensive layer of the same guarantee.
      this.#timer = null;
      if (this.#activeCount === 0) this.#onIdle();
    }, this.#idleMs);
    this.#timer.unref();
  }
}
