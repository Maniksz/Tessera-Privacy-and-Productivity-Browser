Feature: Split view
  As someone watching several streams at once
  I want the content area divided into independent tiles
  So that I can follow all of them without juggling windows

  The requirements these scenarios protect, from specification section 2:
    - shrinking the layout must not close tabs, only unassign them
    - website fullscreen inside a split layout stays within its own tile and the
      other tiles keep running
    - the escalation ladder is tile fullscreen, tile maximised, window fullscreen,
      and Escape steps back exactly one rung
    - a maximised tile does not discard the layout

  Background:
    Given a window with the single tile layout

  Scenario Outline: Each layout offers the declared number of tiles
    When I switch to the "<layout>" layout
    Then the window has <tiles> tiles

    Examples:
      | layout | tiles |
      | 1x1    | 1     |
      | 1x2    | 2     |
      | 2x1    | 2     |
      | 2x2    | 4     |
      | 1+2    | 3     |
      | 1x3    | 3     |
      | 1x4    | 4     |

  Scenario: Tabs are assigned to tiles
    Given the "2x2" layout
    And tabs "a, b, c, d"
    When I assign tab "a" to tile 0
    And I assign tab "b" to tile 3
    Then tile 0 shows tab "a"
    And tile 3 shows tab "b"
    And tile 1 is empty

  Scenario: One tab cannot occupy two tiles
    Given the "1x2" layout
    And tabs "a"
    When I assign tab "a" to tile 0
    And I assign tab "a" to tile 1
    Then tile 0 is empty
    And tile 1 shows tab "a"

  Scenario: Assigning over an occupied tile displaces rather than closes
    Given the "1x2" layout
    And tabs "a, b"
    When I assign tab "a" to tile 0
    And I assign tab "b" to tile 0
    Then tile 0 shows tab "b"
    And tab "a" is not in any tile

  Scenario: Shrinking the layout does not close tabs
    Given the "2x2" layout
    And tabs "a, b, c, d"
    When I assign tab "a" to tile 0
    And I assign tab "b" to tile 1
    And I assign tab "c" to tile 2
    And I assign tab "d" to tile 3
    And I switch to the "1x1" layout
    Then tile 0 shows tab "a"
    And tab "d" is not in any tile
    And no tab was closed

  Scenario: Unassigning a tab keeps it loaded
    Given the "1x2" layout
    And tabs "a"
    When I assign tab "a" to tile 0
    And I unassign tab "a"
    Then tab "a" is not in any tile
    And no tab was closed

  Scenario: Dividers snap to an even split
    Given the "1x2" layout
    When I drag the "v" divider to 0.505
    Then the "v" divider sits at 0.5

  Scenario: A divider cannot make a tile smaller than the minimum
    Given the "1x2" layout
    When I drag the "v" divider to 0.0
    Then tile 0 is at least 240 pixels wide

  Scenario Outline: A wide row keeps its boundaries in order however they are dragged
    Given the "<layout>" layout
    When I drag the "<divider>" divider to <position>
    Then the column boundaries are in left-to-right order
    And every tile has a width of its own

    Examples: dragging a boundary past the one beside it
      | layout | divider | position |
      | 1x3    | v2      | 0.05     |
      | 1x3    | v       | 0.95     |
      | 1x4    | v2      | 0.02     |
      | 1x4    | v3      | 0.1      |
      | 1x4    | v       | 0.99     |

  Scenario: A column of a wide row cannot be squeezed below the minimum
    Given the "1x4" layout
    When I drag the "v" divider to 0.0
    Then every tile is at least 240 pixels wide
    And the column boundaries are in left-to-right order

  Scenario: Arrow navigation walks along a wide row one column at a time
    Given the "1x4" layout
    When I move the active tile "right"
    Then tile 1 is active
    When I move the active tile "right"
    Then tile 2 is active
    When I move the active tile "left"
    Then tile 1 is active

  Scenario: A row of columns has no neighbour above or below to move to
    Given the "1x3" layout
    When I move the active tile "down"
    Then tile 0 is active

  Scenario: Closing a tab in a wide row leaves a narrower row, not a grid
    Given the "1x4" layout
    And tabs "a, b, c, d"
    When I assign tab "a" to tile 0
    And I assign tab "d" to tile 3
    And I switch to the "1x3" layout
    Then the window has 3 tiles
    And tile 0 shows tab "a"
    And tab "d" is not in any tile
    And no tab was closed

  Scenario: Arrow navigation moves between neighbouring tiles
    Given the "2x2" layout
    When I move the active tile "right"
    Then tile 1 is active
    When I move the active tile "down"
    Then tile 3 is active
    When I move the active tile "left"
    Then tile 2 is active

  Scenario: Arrow navigation does not wrap silently at the edge
    Given the "2x2" layout
    When I move the active tile "left"
    Then tile 0 is active

  Scenario: Website fullscreen stays inside its tile
    Given the "2x2" layout
    And tabs "a, b"
    When I assign tab "a" to tile 0
    And I assign tab "b" to tile 1
    And tab "a" requests fullscreen
    Then the escalation level is "tile-fullscreen"
    And the window is not in fullscreen
    And tile 1 is still visible

  Scenario: Website fullscreen in the single layout uses the whole window
    Given the "1x1" layout
    Then window fullscreen is permitted

  Scenario: Website fullscreen in a split layout does not permit window fullscreen
    Given the "2x2" layout
    Then window fullscreen is not permitted

  Scenario: Maximising a tile keeps the layout
    Given the "2x2" layout
    When I maximise tile 2
    Then the escalation level is "tile-maximized"
    And tile 2 fills the content area
    When I press Escape
    Then the escalation level is "none"
    And the window still has 4 tiles

  Scenario: Escape steps back one rung at a time
    Given the "2x2" layout
    And tabs "a"
    When I assign tab "a" to tile 0
    And tab "a" requests fullscreen
    And I maximise tile 0
    Then the escalation level is "tile-maximized"
    When I press Escape
    Then the escalation level is "tile-fullscreen"
    When I press Escape
    Then the escalation level is "none"

  Scenario: Escape does nothing when there is nothing to step back from
    Given the "2x2" layout
    When I press Escape
    Then the escalation level is "none"

  Scenario: Layout, divider positions and mute state survive a restart
    Given the "1+2" layout
    When I drag the "v" divider to 0.7
    And I mute tile 1
    And the window state is saved and restored
    Then the layout is "1+2"
    And the "v" divider sits at 0.7
    And tile 1 is muted

  Scenario: Only the active tile is audible when that option is on
    Given the "2x2" layout
    And the option "only active tile audible" is on
    When I focus tile 0
    Then tile 0 is audible
    And tile 1 is not audible
