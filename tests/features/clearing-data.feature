Feature: Bookmarking and clearing data from the menu
  As someone who reaches for the menu, or its keys, while another application is in front
  I want Strg+D, "Clear Browsing Data…" and "Delete Everything and Quit" to act at once
  So that a key that promises to save a page or erase my traces really does

  The requirements these scenarios protect, from the roadmap plan:
    - R13: Strg+D bookmarks the active page; a read-only bookmarks file is said, not swallowed
    - R14: "Clear Browsing Data…" asks for what to clear and clears it at once, in the session
      of the window it was asked in
    - R15: "Delete Everything and Quit" deletes the browsing traces after one confirmation and
      quits; the next start restores no tabs
    - R16: all three work with no window of Tessera focused
    - AE4: after panic and a restart history, cookies and tabs are gone, three bookmarks are not

  Background:
    Given a profile with a visit to "https://visited.example/", ten open tabs and three bookmarks
    And a normal window on "https://work.example/" focused last, and no window focused now

  Scenario: Strg+D bookmarks the page of the window focused last, once (R13, R16)
    When I press Strg+D
    Then "https://work.example/" is bookmarked
    When I press Strg+D
    Then "https://work.example/" is bookmarked once

  Scenario: A read-only bookmarks file is said, not swallowed (R13)
    Given the bookmarks file was written by a newer version of Tessera
    When I press Strg+D
    Then a notice says "This page could not be bookmarked"
    And the bookmarks file is as the newer version wrote it

  Scenario: Clearing only the cache keeps the history (R14)
    When I clear browsing data choosing "Only the Cache"
    Then the history still holds "https://visited.example/"
    And only the cache of the normal session was cleared

  Scenario: Clearing in a private window leaves the normal session alone (R14)
    Given a private window focused last
    When I clear browsing data choosing "Clear Everything"
    Then the normal session was not touched
    And the history still holds "https://visited.example/"

  Scenario: Panic deletes the traces and keeps the bookmarks (R15, AE4)
    When I choose "Delete Everything and Quit" and confirm it
    Then Tessera quits
    When Tessera starts again
    Then the history is empty
    And no tab comes back
    And the three bookmarks are still there

  Scenario: Panic asks first, and a "no" deletes nothing (R15)
    When I choose "Delete Everything and Quit" and cancel it
    Then Tessera is still running
    And the history still holds "https://visited.example/"

  Scenario: A panic cut short by a crash restores no tab (R15)
    Given a panic that crashed right after writing its note
    When Tessera starts again
    Then no tab comes back
