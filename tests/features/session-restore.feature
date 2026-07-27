Feature: Session restore
  As someone who quits the browser with twenty tabs open
  I want the tabs, the layout and the tiles back the way I left them
  So that closing the browser is not a decision about my work

  What these scenarios pin down, from specification section 3:
    - a restore brings the tabs back without fetching them: only the pages a tile is
      about to show are loaded, so a restore is at most four requests and never twenty
    - a tab that loses its place is detached, never closed — the same rule the split
      view obeys when a layout shrinks
    - restoring the session is the one thing that can make the browser unable to start,
      so a restore that keeps crashing is abandoned rather than retried for ever
    - a restored tab comes back under the id it had, which is the only way a saved tab
      group can be reattached — and the counter has to be raised past it, or two pages
      end up answering to one id

  Scenario: Tabs, layout and tile assignment come back the way they were left
    Given a saved window with the "1+2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
      | https://b.example/ | B     | 2    |
      | https://c.example/ | C     |      |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the session is restored
    And the restored window uses the "1+2" layout
    And the restored strip has 3 tabs
    And tile 0 shows the tab for "https://a.example/"
    And tile 2 shows the tab for "https://b.example/"

  Scenario: Restoring twenty tabs makes four requests, not twenty
    Given a saved window with the "2x2" layout and 20 tabs, 4 of them in tiles
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored strip has 20 tabs
    And 4 restored tabs load at once
    And 16 restored tabs wait until they are asked for

  Scenario Outline: Either way of asking for the session counts as asking
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the setting "<setting>" is <value>
    When the browser restarts
    Then the session is restored

    Examples: a switch that flips has to do something
      | setting                   | value     |
      | session.restoreOnStart    | on        |
      | session.startupBehaviour  | "restore" |

  Scenario: Nothing comes back unless it was asked for
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    When the browser restarts
    Then the session is not restored, because "not-requested"

  Scenario: A saved layout the settings no longer allow detaches tabs instead of stacking them
    Given a saved window with the "2x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
      | https://b.example/ | B     | 1    |
      | https://c.example/ | C     | 2    |
      | https://d.example/ | D     | 3    |
    And the setting "session.restoreOnStart" is on
    And the setting "splitView.restoreLayoutOnStart" is off
    And the setting "splitView.defaultLayout" is "1x1"
    When the browser restarts
    Then the restored window uses the "1x1" layout
    And the restored strip has 4 tabs
    And 1 restored tab holds a tile
    And 3 restored tabs hold no tile
    And no two restored tabs claim the same tile

  Scenario: A window whose tabs were all out of view still comes up showing one
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     |      |
      | https://b.example/ | B     |      |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then 1 restored tab holds a tile
    And tile 0 shows the tab for "https://a.example/"

  Scenario: The window comes up focused on a tile that has a tab in it
    Given a saved window with the "2x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 2    |
    And the saved window was focused on tile 3
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored window is focused on tile 2

  Scenario: The start page is not somewhere to come back to, pinned or not
    Given a saved window with the "1x2" layout and these tabs:
      | address            | title | tile | pinned |
      | tessera://start    | New   | 0    | yes    |
      | https://a.example/ | A     | 1    | no     |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored strip has 1 tab
    And no restored tab points at "tessera://start"

  Scenario: A tab caught mid-navigation comes back where it was, not where it was going
    Given a saved window with the "1x1" layout and these tabs:
      | address                      | pending                          | title   | tile |
      | https://news.example/article | https://news.example/heavy-page  | Article | 0    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the tab for "https://news.example/article" is restored
    And no restored tab points at "https://news.example/heavy-page"

  Scenario: A tab that had committed nothing yet is not lost
    Given a saved window with the "1x1" layout and these tabs:
      | address | pending             | title | tile |
      |         | https://a.example/x | A     | 0    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the tab for "https://a.example/x" is restored

  Scenario: A divider the layout does not have is not carried into the restore
    Given a saved window with the "1x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the saved dividers sit at "v: 0.7, v3: 0.9"
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored divider "v" sits at 0.7
    And the restored window has no divider "v3"

  Scenario: A divider saved on the very edge comes back in the middle, not as a tile with no width
    Given a saved window with the "1x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the saved dividers sit at "v: 0"
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored divider "v" sits at 0.5

  Scenario: A restored tab keeps its id, and no new tab can be handed the same one
    Given a saved window with the "1x2" layout and these tabs:
      | id     | address            | title | tile |
      | tab-7  | https://a.example/ | A     | 0    |
      | tab-12 | https://b.example/ | B     | 1    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts
    Then the restored tab for "https://a.example/" keeps the id "tab-7"
    And no tab created this launch can be given a restored id

  Scenario: One crash is forgiven
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts and never reports itself running
    And the browser restarts
    Then the session is restored

  Scenario: A restore that keeps crashing the browser is abandoned rather than retried for ever
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts and never reports itself running
    And the browser restarts and never reports itself running
    And the browser restarts
    Then the session is not restored, because "restore-keeps-crashing"
    And the crash-loop counter is back to zero

  Scenario: A browser that came up properly is not held back by the crash before it
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the setting "session.restoreOnStart" is on
    When the browser restarts and never reports itself running
    And the browser restarts and reports itself running
    And the browser restarts
    Then the session is restored
    And the crash-loop counter is back to zero

  Scenario: Refusing the session after a crash is stricter than the crash-loop counter
    Given a saved window with the "1x1" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
    And the setting "session.restoreOnStart" is on
    And the setting "session.restoreAfterCrash" is off
    When the browser restarts and never reports itself running
    And the browser restarts
    Then the session is not restored, because "previous-launch-crashed"

  Scenario: A session file naming one tab twice does not bring back two tabs under one id
    Given a saved window with the "1x2" layout and these tabs:
      | id    | address            | title | tile |
      | tab-3 | https://a.example/ | A     | 0    |
      | tab-3 | https://b.example/ | B     | 1    |
    When the session file is read back
    Then the saved window holds 1 tab

  Scenario: Two tabs saved in one tile come back with one of them detached, not closed
    Given a saved window with the "1x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 1    |
      | https://b.example/ | B     | 1    |
    When the session file is read back
    Then the saved window holds 2 tabs
    And the saved tab for "https://b.example/" holds no tile

  Scenario: A tab saved in a tile the layout does not have comes back detached
    Given a saved window with the "1x2" layout and these tabs:
      | address            | title | tile |
      | https://a.example/ | A     | 0    |
      | https://b.example/ | B     | 3    |
    When the session file is read back
    Then the saved window holds 2 tabs
    And the saved tab for "https://b.example/" holds no tile
