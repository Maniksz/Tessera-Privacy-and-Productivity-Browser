Feature: A tiled view is one entry in the tab strip
  As someone watching several pages side by side
  I want the tiled pages to be one entry I can put away, bring back and end
  So that switching to another tab never costs me the grid, and ending it
  leaves me the pages I actually opened

  The requirements these scenarios protect, from the plan that made a tiled
  view an entry of its own:
    - R3: a click on an ordinary tab puts the visible tiled view away; its entry
      stays, with its layout and its active tile
    - R4: a click on the entry brings the view back with its last active tile
    - R8: ending a tiled view closes its start-page tiles first; the other pages
      become ordinary tabs where the entry stood

  In the strip below, a tiled view reads as its members in tile order between
  brackets, "[a | b]", because it is drawn as one entry and not as its tabs.

  Scenario: Another tab puts the tiled view away, and its entry brings it back
    # AE1. The view stays one entry while another page has the window, and
    # comes back as it was left: the same pages in the same tiles, with the
    # tile the user was in still the active one.
    Given a window tiling tabs "youtube, twitch" side by side
    And a loose tab "mail"
    When the window settles
    And I click into the tile showing "twitch"
    And I click the tab "mail"
    And the window settles
    Then the window shows only "mail"
    And the tiled view is put away as "youtube, twitch" in the "1x2" layout with "twitch" active
    And the tab strip reads "[youtube | twitch], mail"
    When I click the entry of the tiled view
    And the window settles
    Then the window shows "youtube, twitch" in the "1x2" layout
    And the active tile shows "twitch"
    And the tab strip reads "[youtube | twitch], mail"

  Scenario: Ending a tiled view closes its start page and leaves the rest where the entry stood
    # AE3. Ending is a decision about the panes, so the start page that only
    # filled one closes, whoever opened it. The pages the user loaded stay, as
    # ordinary tabs in tile order at the entry's place in the strip, and the
    # page of the active tile is the one on screen.
    Given a window tiling tabs "youtube, start page, twitch" in the "1x3" layout
    And a loose tab "mail" at the front of the strip
    And a loose tab "news"
    When the window settles
    And I click into the tile showing "twitch"
    And I choose "End Tiled View" from the menu of the tiled view
    And the window settles
    Then the tab "start page" is closed
    And the window holds no tiled view
    And the window shows only "twitch"
    And the tab strip reads "mail, youtube, twitch, news"
