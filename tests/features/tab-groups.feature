Feature: Tab groups belong to the user
  As someone who has put a few tabs into a group on purpose
  I want the group to change only when I change it
  So that dissolving one is a decision the browser does not quietly undo

  The requirements this scenario protects, from the tab-group ownership rebuild:
    - R1: a group comes into being only because a user asked for one; tiling,
      switching layout and restoring a session create none
    - R2: a group ends when the user dissolves it or its last member closes, and
      no automatic pass brings it back afterwards
    - R4: "dissolve grouping" holds whatever the layout is and however many tiles
      are occupied

  Scenario: Dissolving a group of tiled tabs takes its chip away, and it stays away
    # The defect as it was reported. Two tabs side by side in a named group, the
    # user dissolves it, and the chip was back before they let go of the mouse —
    # because the pass that keeps the tiling written down had nowhere but a group
    # to write it, so it made one. Both settles matter: the first is what put a
    # tiling on record at all, the second is the pass that used to undo the
    # dissolve.
    Given a window tiling tabs "research, notes" side by side
    And the tabs "research, notes" are grouped as "Reading"
    When the window settles
    And I dissolve the group "Reading"
    And the window settles
    Then the tab strip shows no group chip
    And the tab strip still shows tabs "research, notes"

  Scenario: A tab found by the tab search comes out of its folded group
    # R31. A folded group is drawn as its chip alone, so the tab search is the
    # one list that still has its members — and a tab brought to the front from
    # there must not stay behind the chip, where nothing on screen says where
    # the page came from.
    Given a window tiling tabs "mail, news" side by side
    And the tabs "news" are grouped as "Later"
    And the group "Later" is folded
    When I search the tabs for "news"
    Then the tab search lists "news" first
    When I activate the first tab the search lists
    Then the group "Later" is open
    And the tab strip still shows tabs "mail, news"
