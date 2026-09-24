Feature: Closing asks a page that has something to lose
  As someone halfway through writing in a page
  I want to be asked before a close or a click throws my text away
  So that "Stay" means everything stays as it was, and quitting never holds me up

  The requirements these scenarios protect, from the roadmap plan:
    - R11: closing a tab or a window, and navigating away from a page with
      `beforeunload`, asks first, naming the site; "Stay" leaves everything as it was
    - R12: quitting, panic, logging off and installing an update never ask
    - AE3: "Stay" keeps the tab open and puts nothing on the recently-closed stack

  Scenario: Staying keeps the tab and leaves the recently closed tabs alone
    # AE3 as written. The close is a request to the page now, and the tab's
    # bookkeeping waits for the page to go — so a page that stays finishes nothing.
    Given a window whose tabs are "mail, news"
    And the page in "mail" asks before it is left
    When I close the tab "mail" and answer "Stay"
    Then the question named "mail.example"
    And the tab "mail" is still open
    And the recently closed tabs are ""

  Scenario: Leaving closes the tab once
    Given a window whose tabs are "mail, news"
    And the page in "mail" asks before it is left
    When I close the tab "mail" and answer "Leave"
    Then the tab "mail" is gone
    And the recently closed tabs are "mail"

  Scenario: A page with nothing to lose closes without a question
    Given a window whose tabs are "mail, news"
    When I close the tab "news" and answer "Stay"
    Then no question was asked
    And the tab "news" is gone

  Scenario: Closing a window asks tab by tab and stops at the first "Stay"
    # Electron cannot ask a page without starting to close it, so the tabs go one
    # at a time: the first had nothing to ask and is already gone when the third
    # says stay, which is why it is on the stack of the window left open.
    Given a window whose tabs are "news, mail, docs"
    And the page in "mail" asks before it is left
    And the page in "docs" asks before it is left
    When I close that window and answer "Leave, Stay"
    Then the window is still open
    And the tab "docs" is in front
    And the recently closed tabs are "news, mail"

  Scenario: Leaving a page by a link loads the link's target
    Given a window whose tabs are "mail"
    And the page in "mail" asks before it is left
    When I follow a link in "mail" to "https://elsewhere.example/" and answer "Leave"
    Then "mail" shows "https://elsewhere.example/"
    And exactly one question was asked

  Scenario: Quitting asks nothing, whatever the pages say
    Given a window whose tabs are "mail, news"
    And the page in "mail" asks before it is left
    When the browser quits
    Then no question was asked
    And the window has closed
    And the recently closed tabs are ""
