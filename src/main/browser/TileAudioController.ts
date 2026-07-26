import type { SplitController } from './SplitController.js'

/**
 * Which tiles are allowed to make sound.
 *
 * Extracted from `BrowserWindowController` because it is genuinely one idea — "only the tile you are looking at
 * makes sound, unless you said otherwise" — and because inside a window it could not be tested at all. The rule
 * has three inputs that interact: a tile the user muted by hand, a setting that mutes everything but the active
 * tile, and a second setting that does very nearly the same thing. Getting the interaction wrong produces a
 * browser that is silent when it should not be, which people report as "the audio button is broken".
 *
 * The seam is deliberately thin: `SplitController` already answers *whether* a tile should be muted, per tile.
 * What was in the window was the loop over the tiles, the settings read, and the resolution of a tile to the
 * `Tab` object that can actually be muted — and the third of those is the only part that needs a window.
 */

export interface TileAudioHost {
  split: SplitController
  /** Whether only the active tile may be audible. */
  onlyActiveAudible(): boolean
  /** The second, near-identical setting; both are honoured because both exist in the settings screen. */
  muteAllButActive(): boolean
  /**
   * Mutes or unmutes the tab in a tile.
   *
   * By tile rather than by tab id, because a tile with no tab is a tile with nothing to mute and the host is the
   * only side that can tell. Doing nothing for an empty tile is correct and is why this returns nothing.
   */
  setTileMuted(tileIndex: number, muted: boolean): void
}

export class TileAudioController {
  private readonly host: TileAudioHost

  constructor(host: TileAudioHost) {
    this.host = host
  }

  /**
   * Brings every tile's mute state in line with the policy.
   *
   * Applied to *all* tiles on every change rather than only to the one that changed, and that is not
   * inefficiency: switching the active tile changes the answer for the tile being left as well as for the one
   * being entered, and a version that touched only one of them would leave sound coming from a tile nobody is
   * looking at. There are at most four.
   */
  apply(): void {
    const onlyActive = this.host.onlyActiveAudible()
    const muteAllButActive = this.host.muteAllButActive()

    for (let index = 0; index < this.host.split.tileCount; index++) {
      this.host.setTileMuted(
        index,
        this.host.split.shouldTileBeMuted(index, onlyActive, muteAllButActive)
      )
    }
  }

  /**
   * Records a mute the user asked for, then re-applies the policy.
   *
   * Both halves, in that order. Writing the flag without re-applying would leave the view unmuted until the next
   * unrelated change; re-applying without writing it would unmute the tile again immediately, because the policy
   * is computed from the flag.
   */
  setMutedByUser(tileIndex: number, muted: boolean): void {
    this.host.split.setTileMuted(tileIndex, muted)
    this.apply()
  }
}
