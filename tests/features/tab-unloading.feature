Feature: Tab unloading
  As someone who keeps forty tabs open and uses four
  I want the ones I have left alone to give their memory back
  So that the browser stays fast without me closing anything

  What these scenarios pin down, from R26 and KTD9:
    - a tab left alone for the setting's minutes is unloaded by the one timer, and is on by default
    - a tile, sound, a paused or muted video, a pin, a load, open devtools, fullscreen, a waiting
      prompt, unsent typing, an internal page and a failure each keep a tab loaded
    - a page that objects keeps its tab loaded
    - an unloaded tab comes back with its history, at the page it was on, in a new view
    - a tab session restore brought back unfetched is a different thing: it keeps its view

  Scenario: A tab left alone past the setting is unloaded
    Given a background tab left alone for 31 minutes
    When the unloading timer runs
    Then the tab is unloaded

  Scenario: A tab used a moment ago stays
    Given a background tab left alone for 29 minutes
    When the unloading timer runs
    Then the tab is still loaded

  Scenario: A paused video keeps its tab (AE7)
    Given a background tab left alone for 30 minutes
    And the tab has a paused video
    When the unloading timer runs
    Then the tab is still loaded

  Scenario Outline: What keeps a tab loaded
    Given a background tab left alone for 90 minutes
    And the tab <condition>
    When the unloading timer runs
    Then the tab is still loaded

    Examples: each of these would lose the user something
      | condition                          |
      | is shown in a tile                 |
      | is playing sound                   |
      | is pinned                          |
      | is still loading                   |
      | has typing nobody sent             |
      | shows an internal page             |
      | shows a failure                    |
      | has a permission question waiting  |

  Scenario: Switched off, nothing is unloaded
    Given a background tab left alone for 600 minutes
    And the setting "advanced.unloadInactiveTabs" is off
    When the unloading timer runs
    Then the tab is still loaded

  Scenario: The minutes come from the setting
    Given a background tab left alone for 45 minutes
    And tabs unload after 60 minutes
    When the unloading timer runs
    Then the tab is still loaded

  Scenario: A page that objects keeps its tab
    Given a background tab left alone for 31 minutes
    And its page objects to being unloaded
    When the unloading timer runs
    Then the tab is still loaded

  Scenario: An unloaded tab comes back where it was
    Given a background tab left alone for 31 minutes
    And the tab was on the second of two pages
    When the unloading timer runs
    And the tab is activated
    Then the tab has a new view at the bottom of the window
    And its history is restored at the second page

  Scenario: A tab restored unfetched loads into the view it has
    Given a tab session restore brought back unfetched
    When the tab is activated
    Then the tab keeps its view and loads its address
