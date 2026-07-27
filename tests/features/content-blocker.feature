Feature: The content blocker's lists
  As someone whose blocker is only as good as the lists behind it
  I want the rules to follow the lists I chose, and to survive a bad connection
  So that "the blocker does not work on this site" is a question I can answer

  The engine and the on-disk cache each existed and were tested; nothing joined them to
  the setting that says which lists to use. This is that joint, and every scenario here
  is a failure mode rather than a happy path — because the happy path is one line and
  the failures are what a person experiences as a blocker that stopped working:
    - a failed download must leave the previous rules in place. A browser with a stale
      list still blocks; a browser with no list does not
    - switching the blocker off has to mean no rules compiled, not a check somewhere
      else. Rules left compiled behind a flag are one forgotten check away from a
      blocker that still blocks after the user turned it off
    - starting must not wait for the network, or a slow connection looks like a slow
      browser and an offline start looks like a broken one
    - two refreshes at once corrupt the cache, and the visible result is a blocker with
      fewer lists than it downloaded, with nothing anywhere saying why

  Scenario: A list that cannot be downloaded leaves the rules that were already there
    Given these filter lists:
      | address                       | blocks      | download |
      | https://lists.example/ads.txt | ads.example | works    |
    When the blocker starts
    Then a request to "https://ads.example/a.js" is blocked
    When "https://lists.example/ads.txt" can no longer be downloaded
    And the blocker refreshes
    Then a request to "https://ads.example/a.js" is blocked
    And the blocker reports 1 list configured and 1 loaded

  Scenario: The browser opens with the rules it already had, without waiting for a download
    Given these filter lists:
      | address                       | blocks      | download |
      | https://lists.example/ads.txt | ads.example | works    |
    When the blocker starts
    And the browser starts again while the network never answers
    Then a request to "https://ads.example/a.js" is blocked

  Scenario: Switching the blocker off compiles nothing, rather than skipping a check
    Given these filter lists:
      | address                       | blocks      | download |
      | https://lists.example/ads.txt | ads.example | works    |
    When the blocker starts
    And the blocker is switched off
    Then no rules are compiled at all
    And a request to "https://ads.example/a.js" is allowed

  Scenario: A list the user removes stops applying without a restart
    Given these filter lists:
      | address                         | blocks        | download |
      | https://lists.example/ads.txt   | ads.example   | works    |
      | https://lists.example/track.txt | track.example | works    |
    When the blocker starts
    And the list "https://lists.example/track.txt" is taken out of the settings
    Then a request to "https://ads.example/a.js" is blocked
    And a request to "https://track.example/p.gif" is allowed

  Scenario: Two refreshes at once do not lose a list
    Given these filter lists:
      | address                         | blocks        | download |
      | https://lists.example/ads.txt   | ads.example   | works    |
      | https://lists.example/track.txt | track.example | works    |
    When two refreshes are asked for at once
    Then the blocker reports 2 lists configured and 2 loaded
    And a request to "https://ads.example/a.js" is blocked
    And a request to "https://track.example/p.gif" is blocked

  Scenario: One list of four failing is a thing the blocker can say out loud
    Given these filter lists:
      | address                         | blocks        | download |
      | https://lists.example/ads.txt   | ads.example   | works    |
      | https://lists.example/track.txt | track.example | fails    |
    When the blocker starts
    Then the blocker reports 2 lists configured and 1 loaded
    And the blocker says "https://lists.example/track.txt" could not be downloaded
    And a request to "https://ads.example/a.js" is blocked
