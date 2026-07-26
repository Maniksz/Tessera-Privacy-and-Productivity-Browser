Feature: Quick links on the start page
  As someone who opens the same handful of sites every day
  I want tiles on the start page I can create, open, organise and remove
  So that I do not have to type or search for them

  Rules from the specification that these scenarios pin down:
    - a tile's address is resolved exactly as the address bar resolves input,
      and a search term is refused rather than silently turned into a search
    - folders hold links, but folders never hold folders
    - deleting a folder deletes what is inside it, rather than orphaning it
    - reordering is explicit and survives being read back from disk

  Background:
    Given an empty set of quick links

  Scenario: Creating a tile from a bare domain
    When I add a tile named "News" for "example.com"
    Then there is 1 tile at the top level
    And the tile "News" points at "https://example.com"

  Scenario: The name falls back to the domain
    When I add a tile named "" for "https://www.example.com/deep/path"
    Then the tile list contains a tile named "example.com"

  Scenario: A search term is refused, not turned into a search
    When I try to add a tile named "Bad" for "how tall is everest"
    Then the attempt fails with "InvalidQuickLinkUrlError"
    And there are 0 tiles at the top level

  Scenario: A javascript URL is refused
    When I try to add a tile named "Bad" for "javascript:alert(1)"
    Then the attempt fails with "InvalidQuickLinkUrlError"

  Scenario Outline: Addresses that are accepted
    When I add a tile named "T" for "<input>"
    Then the tile "T" points at "<stored>"

    Examples:
      | input                  | stored                        |
      | example.com            | https://example.com           |
      | http://example.com/x   | http://example.com/x          |
      | localhost:5173         | https://localhost:5173        |
      | 192.168.1.10           | https://192.168.1.10          |
      | sub.example.co.uk/page | https://sub.example.co.uk/page |

  Scenario: Renaming a tile
    Given a tile named "Old" for "example.com"
    When I rename the tile "Old" to "New"
    Then the tile list contains a tile named "New"
    And the tile list does not contain a tile named "Old"

  Scenario: Reordering tiles
    Given the following tiles:
      | name | url         |
      | A    | a.example   |
      | B    | b.example   |
      | C    | c.example   |
    When I move the tile "C" to position 0
    Then the top level order is "C, A, B"

  Scenario: Moving a tile past the end appends it
    Given the following tiles:
      | name | url       |
      | A    | a.example |
      | B    | b.example |
    When I move the tile "A" to position 99
    Then the top level order is "B, A"

  Scenario: Filing a tile into a folder
    Given a folder named "Work"
    And a tile named "Docs" for "docs.example"
    When I move the tile "Docs" into the folder "Work"
    Then the folder "Work" contains 1 tile
    And there is 1 tile at the top level

  Scenario: Folders cannot be nested
    Given a folder named "Work"
    When I try to add a folder named "Inner" inside the folder "Work"
    Then the attempt fails with "QuickLinkNestingError"

  Scenario: A folder cannot be moved into another folder
    Given a folder named "Work"
    And a folder named "Home"
    When I try to move the tile "Home" into the folder "Work"
    Then the attempt fails with "QuickLinkNestingError"

  Scenario: A tile cannot be moved into itself
    Given a folder named "Work"
    When I try to move the tile "Work" into the folder "Work"
    Then the attempt fails with "QuickLinkNestingError"

  Scenario: Deleting a folder deletes what is inside it
    Given a folder named "Work"
    And a tile named "Docs" for "docs.example" inside the folder "Work"
    And a tile named "Keep" for "keep.example"
    When I remove the tile "Work"
    Then the tile list contains a tile named "Keep"
    And the tile list does not contain a tile named "Docs"
    And there is 1 tile at the top level

  Scenario: A folder has no address to edit
    Given a folder named "Work"
    When I try to set the address of "Work" to "example.com"
    Then the attempt fails with "QuickLinkNestingError"

  Scenario: Quick links survive a restart
    Given the following tiles:
      | name | url       |
      | A    | a.example |
      | B    | b.example |
    When I move the tile "B" to position 0
    And the quick links are written and read back
    Then the top level order is "B, A"

  Scenario: A corrupt file does not lose the browser
    Given the quick links file contains "{ this is not json"
    When the quick links are read
    Then there are 0 tiles at the top level
    And the store reports that it recovered from an invalid file

  Scenario: An orphaned tile is moved to the top level rather than hidden
    Given the quick links file references a folder that does not exist
    When the quick links are read
    Then there is 1 tile at the top level
