Feature: Bookmarks
  As someone who keeps a few hundred pages worth returning to
  I want folders inside folders, a bar for the handful I use daily
  So that a collection built over years stays usable

  Where bookmarks genuinely differ from the quick links on the start page, and what
  each difference costs if it is missed:
    - folders hold folders, so deleting one has to take its grandchildren too. Taking
      only the direct children leaves entries filed under a folder that no longer
      exists: invisible, counted against the limit, and back again the moment the file
      is repaired — data loss followed by data resurrection
    - a tree can be made into a ring, and a ring is not a shape a listing can draw. It
      is refused on the way in and broken on the way back out of the file
    - a bookmark is an address that will be requested for years, so it is stored the
      way the address bar would resolve it, with campaign parameters removed
    - a file exported by another browser is untrusted input that a person chose to
      open, which is not the same as trustworthy

  Background:
    Given an empty set of bookmarks

  Scenario: Deleting a folder takes what is inside it, at every depth
    Given these bookmarks:
      | kind     | title   | address               | inside  |
      | folder   | Recipes |                       | other   |
      | folder   | Baking  |                       | Recipes |
      | bookmark | Bread   | https://bread.example | Baking  |
      | bookmark | Keep    | https://keep.example  | other   |
    When I delete "Recipes"
    Then the bookmark tree holds 1 entry
    And the bookmark tree holds "Keep"
    And the bookmark tree does not hold "Bread"

  Scenario: A folder cannot be moved into one of its own folders
    Given these bookmarks:
      | kind   | title   | address | inside  |
      | folder | Recipes |         | other   |
      | folder | Baking  |         | Recipes |
    When I try to move "Recipes" into "Baking"
    Then the attempt fails with "BookmarkNestingError"
    And "Baking" sits in the folder "Recipes"

  Scenario: A folder cannot be moved into itself
    Given these bookmarks:
      | kind   | title   | address | inside |
      | folder | Recipes |         | other  |
    When I try to move "Recipes" into "Recipes"
    Then the attempt fails with "BookmarkNestingError"

  Scenario: A bookmark is not a container
    Given these bookmarks:
      | kind     | title | address               | inside |
      | bookmark | Bread | https://bread.example | other  |
      | bookmark | Keep  | https://keep.example  | other  |
    When I try to move "Keep" into "Bread"
    Then the attempt fails with "BookmarkNestingError"

  Scenario: A file whose folders sit inside each other is repaired, not thrown away
    Given a bookmark file in which the folders "Recipes" and "Baking" each sit inside the other
    When the bookmark file is read back
    Then the bookmark tree holds 2 entries
    And "Recipes" sits under other bookmarks
    And "Baking" sits under other bookmarks

  Scenario: An entry whose folder is gone comes back under other bookmarks, not on the bar
    Given a bookmark file with a bookmark filed inside a folder that is not in it
    When the bookmark file is read back
    Then the bookmark tree holds 1 entry
    And the bookmarks bar holds nothing
    And "Orphan" sits under other bookmarks

  Scenario: A folder that arrived carrying an address is not a row with two meanings
    Given a bookmark file with a folder that also carries an address
    When the bookmark file is read back
    Then the folder "Recipes" has no address

  Scenario: A page that added a campaign parameter to its own address still reads as bookmarked
    Given these bookmarks:
      | kind     | title | address                | inside |
      | bookmark | Shop  | https://shop.example/x | bar    |
    Then the page "https://shop.example/x?utm_source=newsletter" reads as bookmarked
    And the bookmark "Shop" points at "https://shop.example/x"

  Scenario: A bookmark keeps the part of the address that says where in the page
    When I bookmark "https://docs.example/guide#installation" as "Install"
    Then the bookmark "Install" points at "https://docs.example/guide#installation"

  Scenario: A bookmarklet is refused, the way it would be if it were typed
    When I try to bookmark "javascript:alert(1)" as "Invoices"
    Then the attempt fails with "InvalidBookmarkUrlError"
    And the bookmark tree holds 0 entries

  Scenario: Fixing a moved page keeps the title, the folder and the place in it
    Given these bookmarks:
      | kind     | title    | address                     | inside |
      | folder   | Work     |                             | other  |
      | bookmark | Handbook | https://old.example/handbook | Work   |
      | bookmark | Rota     | https://rota.example         | Work   |
    When I point "Handbook" at "https://new.example/handbook"
    Then the bookmark "Handbook" points at "https://new.example/handbook"
    And "Handbook" sits in the folder "Work"
    And the folder "Work" lists "Handbook, Rota"

  Scenario: A bookmarklet in an imported file is refused and counted rather than filed
    When I import this bookmark file:
      """
      <DL><p>
        <DT><A HREF="https://example.com/docs">Documentation</A>
        <DT><A HREF="javascript:alert(document.cookie)">Invoices</A>
      </DL><p>
      """
    Then 1 imported entry was refused
    And the bookmark tree holds "Documentation"
    And the bookmark tree does not hold "Invoices"

  Scenario: The other browser's bar becomes this browser's bar, not a folder inside it
    When I import this bookmark file:
      """
      <DL><p>
        <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
        <DL><p>
          <DT><A HREF="https://mail.example/">Mail</A>
        </DL><p>
        <DT><A HREF="https://example.com/docs">Documentation</A>
      </DL><p>
      """
    Then the bookmarks bar holds "Mail"
    And the bookmarks bar does not hold "Bookmarks bar"
    And "Documentation" sits under other bookmarks
