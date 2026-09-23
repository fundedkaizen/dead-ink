/**
 * Sprint stamina, as in Call of Duty: a sprint lasts `seconds`, then the player drops to a run and must let
 * go of sprint before sprinting again. After `recoverDelay` seconds without sprinting the tank refills, empty
 * to full in `refillSeconds`; a new sprint needs at least `restart` seconds of it. A perk (Stamin-Up) sets
 * `unlimited`.
 */
export const SPRINT = { seconds: 4.5, recoverDelay: 1, refillSeconds: 2, restart: 0.4 } as const

export class SprintStamina {
  /** Seconds of sprint left. */
  left: number = SPRINT.seconds
  /** No limit at all (the lead's Stamin-Up style perk). The tank stays full. */
  unlimited = false
  /** Sprinting on the last update. */
  sprinting = false
  /** Ran dry: sprint must be released before it works again. */
  winded = false
  /** Called once each time the tank runs dry (a breath sound, a camera cue). */
  onWinded: () => void = () => {}
  private rested = 0

  /** 0 to 1: how full the tank is. */
  get fraction() { return this.unlimited ? 1 : this.left / SPRINT.seconds }

  /**
   * Advance by `dt`. `wants` is the sprint input (held key, or a latched stick click), `canSprint` whether
   * the player is moving. Returns whether the player sprints this step.
   */
  update(dt: number, wants: boolean, canSprint: boolean) {
    if (!wants) this.winded = false
    let sprinting = wants && canSprint && !this.winded
    if (sprinting && !this.unlimited && (this.left <= 0 || (!this.sprinting && this.left < SPRINT.restart))) sprinting = false
    if (this.unlimited) this.left = SPRINT.seconds
    if (sprinting) {
      this.rested = 0
      if (!this.unlimited) {
        this.left = Math.max(0, this.left - dt)
        if (this.left === 0) { this.winded = true; this.onWinded() }
      }
    } else {
      this.rested += dt
      if (this.rested >= SPRINT.recoverDelay) this.left = Math.min(SPRINT.seconds, this.left + dt * SPRINT.seconds / SPRINT.refillSeconds)
    }
    this.sprinting = sprinting
    return sprinting
  }

  reset() { this.left = SPRINT.seconds; this.sprinting = false; this.winded = false; this.rested = 0 }
}
