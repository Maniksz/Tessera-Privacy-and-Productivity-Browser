Feature: Window layering
  As someone using the browser's own controls
  I want menus and indicators to appear over the page
  So that the controls I can see are the controls I can actually use

  The requirement these scenarios protect: tab content is drawn by native views stacked
  above the browser's own interface, and a native view is opaque to clicks as well as to
  the eye. Interface drawn beneath one is present in the markup and unusable in practice.

  This is exactly how a layout dropdown once shipped. It passed every check that asked
  "is the menu there" and no click ever reached it, because 184 of its 187 pixels were
  behind the page.

  Background:
    Given a window 1200 by 800 with an 88 pixel chrome inset

  Scenario: A menu opened from the toolbar reaches past the chrome and stays in the window
    Given a toolbar button 40 by 32 at 1000, 60
    When a menu 220 by 190 is anchored to that button
    Then the menu opens below the button
    And the menu lies entirely inside the window
    And the menu reaches past the chrome inset

  Scenario: A menu is presented on the layer above page content
    Then the layout menu takes the whole window while it is up

  Scenario: A surface that must leave the tab strip usable takes only the content area
    Then a content region leaves the chrome inset untouched

  Scenario: A button near the bottom edge opens its menu upwards
    Given a toolbar button 40 by 32 at 1000, 700
    When a menu 220 by 190 is anchored to that button
    Then the menu opens above the button
    And the menu lies entirely inside the window

  Scenario: A menu right-aligns with its button so it grows into the window
    Given a toolbar button 40 by 32 at 1000, 60
    When a menu 220 by 190 is anchored to that button
    Then the menu's right edge meets the button's right edge

  Scenario Outline: A menu never leaves the window, wherever its button sits
    Given a toolbar button 40 by 32 at <x>, <y>
    When a menu 220 by 190 is anchored to that button
    Then the menu lies entirely inside the window

    Examples:
      | x    | y   |
      | 0    | 0   |
      | 1190 | 60  |
      | 600  | 790 |
      | 1400 | 900 |
      | -50  | -20 |

  Scenario: Dragging a tab in a single view offers every split plus the view itself
    When a tab is dragged in the "1x1" layout
    Then the drop targets are "left, right, top, bottom, tile"
    And every drop target previews a rectangle inside the tile area

  Scenario: Dragging can reach the three- and four-tile arrangements
    When a tab is dragged in the "1x2" layout
    Then a drop target leads to the "1+2" layout
    And a drop target leads to the "2x2" layout

  Scenario: A vertical edge grows the row of columns rather than reshaping it
    When a tab is dragged in the "1x2" layout
    Then a drop target leads to the "1x3" layout
    And a drop target leads to the "2x2" layout

  Scenario: The row can be grown once more, to four columns
    When a tab is dragged in the "1x3" layout
    Then a drop target leads to the "1x4" layout
    And every drop target previews a rectangle inside the tile area

  Scenario: Four columns is as far as dragging goes
    When a tab is dragged in the "1x4" layout
    Then the drop targets are "tile, tile, tile, tile"

  Scenario: An edge promises the half the page will fill, not the strip it was hovered in
    When a tab is dragged in the "1x1" layout
    And the pointer is 40 pixels inside the left edge of the tile area
    Then the drop target is "left"
    And the promised rectangle is larger than the region hovered

  Scenario: Dragging over the tab strip targets nothing, and that is a state of its own
    When a tab is dragged in the "2x2" layout
    And the pointer is in the tab strip
    Then there is no drop target

  Scenario Outline: Every point in the tile area has a target, gutters included
    When a tab is dragged in the "<layout>" layout
    And the pointer is at <x>, <y>
    Then there is a drop target

    Examples:
      | layout | x   | y   |
      | 1x1    | 600 | 400 |
      | 1x2    | 600 | 400 |
      | 2x1    | 600 | 492 |
      | 2x2    | 600 | 492 |
      | 1+2    | 760 | 492 |
      | 1x3    | 600 | 400 |
      | 1x4    | 450 | 400 |

  Scenario: A menu taller than the window is capped rather than allowed to overflow
    Given a toolbar button 40 by 32 at 1000, 60
    When a menu 220 by 5000 is anchored to that button
    Then the menu lies entirely inside the window
    And the menu is shorter than it asked to be
