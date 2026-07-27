Feature: Find in page
  As someone reading a long page in one of four tiles
  I want to search the page I am looking at
  So that finding a word does not mean losing my place in it

  The requirements these scenarios protect, from specification section 9:
    - the bar searches one tile's page, fixed when the bar opened — with four pages on
      screen, a keystroke must not land on whichever tile happens to be active now
    - typing the next letter of a word is not "find next": sent as a step, the count
      belongs to the old text and the highlight to a match nobody asked for
    - the bar leaving takes the highlight with it. A page carrying a marked block of
      text with nothing on screen to explain it has no affordance for getting rid of it
    - a count that has not arrived is not a count of zero, and "no matches" is a
      sentence rather than the fraction 0 of 0

  Scenario: Typing the next letter searches again rather than stepping to the next match
    Given the find bar is open on the page in tile 0
    When I type "walr" into the find bar
    And I type "walrus" into the find bar
    Then the page in tile 0 is searched for "walrus" from the top
    And the page in tile 0 is not stepped to another match

  Scenario: The same text again is not a new search
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 7 matches, at match 3
    And I type "walrus" into the find bar
    Then nothing is asked of any page
    And the bar shows match 3 of 7

  Scenario: Emptying the field stops the search instead of searching for nothing
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And I clear the search field
    Then the page in tile 0 is told to take its highlight off
    And the bar says nothing about a count

  Scenario: The bar leaving takes the highlight with it
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the find bar goes away
    Then the find bar is gone
    And the page in tile 0 is told to take its highlight off
    And the highlight is taken off rather than left behind as a selection

  Scenario: Asking for the next match after the page changed starts a fresh search
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 7 matches, at match 3
    And the page navigates to another document
    And I ask for the next match
    Then the page in tile 0 is searched for "walrus" from the top
    And the page in tile 0 is not stepped to another match

  Scenario: A search a navigation interrupted picks itself up when the page has loaded
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page navigates to another document
    And the page finishes loading
    Then the page in tile 0 is searched for "walrus" from the top

  Scenario: A page that merely stopped loading does not drag the search back to the first match
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 7 matches, at match 3
    And the page finishes loading
    Then nothing is asked of any page
    And the bar shows match 3 of 7

  Scenario Outline: Only a real page change ends the search
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports the navigation "<navigation>"
    Then the search <outcome>

    Examples: an advertisement iframe reloading is not the user changing page
      | navigation                       | outcome    |
      | a new document in the main frame | is over    |
      | a fragment link on the same page | is running |
      | a subframe loading               | is running |

  Scenario: A keystroke from a bar that is no longer the one on screen changes nothing
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And a keystroke arrives from a bar shown for the page in tile 1
    Then nothing is asked of any page
    And the bar is still searching the page in tile 0

  Scenario: Moving the bar to another tile clears the page it leaves before searching the new one
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And I press the find shortcut for the page in tile 1
    Then the page in tile 0 is told to take its highlight off before the page in tile 1 is searched
    And the bar is still searching the page in tile 1

  Scenario: Reopening the bar searches for the same thing again rather than for nothing
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the find bar goes away
    And I press the find shortcut for the page in tile 0
    Then the page in tile 0 is searched for "walrus" from the top

  Scenario: A search still being counted is not a search that found nothing
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    Then the bar says it is still searching
    When the page reports 0 matches, at match 0
    Then the bar says there are no matches

  Scenario: One match is a statement, not a position
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 1 matches, at match 1
    Then the bar says there is one match

  Scenario: The bar cannot be made to say "7 of 3"
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 3 matches, at match 7
    Then the bar shows match 3 of 3

  Scenario: A count for a search that has been replaced is not shown
    Given the find bar is open on the page in tile 0
    When I type "walr" into the find bar
    And I type "walrus" into the find bar
    And the page answers the search before last with 12 matches
    Then the bar says it is still searching

  Scenario: A count arriving after the page changed is not shown either
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the page reports 7 matches, at match 3
    And the page navigates to another document
    And the page reports 7 matches, at match 3
    Then the bar says it is still searching

  Scenario: The bar sits inside the tile whose page it is counting
    Given the find bar is open on the page in tile 1
    When I type "walrus" into the find bar
    Then the find bar sits inside tile 1

  Scenario: A tile too narrow for the whole bar still keeps it off its neighbour
    Given each tile is 300 pixels wide
    And the find bar is open on the page in tile 1
    When I type "walrus" into the find bar
    Then the find bar sits inside tile 1

  Scenario: A page pushed out of its tile has no bar counting matches in it
    Given the find bar is open on the page in tile 0
    When I type "walrus" into the find bar
    And the searched tab loses its tile
    Then there is no bar over the page
